import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  categorize,
  dataViewerType,
  formatVariableValue,
  isConstant,
  organizeVariables,
  sizeLabel,
  typeHint,
  variableSize,
} from './categorize';
import type { ChildVariable } from './inspect';
import type { JupyterVariablesSource, KernelVariable } from './jupyterApi';
import type { ConsoleSession } from '../console/session';
import type { ConsoleSessionManager } from '../console/sessionManager';
import { ExpandRegistry, type PreviewRow, truncate } from './expandTree';
import { startsNewRun } from '../runs';
import { parsePythonDefinitions } from './pythonDefs';
import type { VariablesOptions } from './variablesOptions';

/**
 * The Jupyter Variables webview view: kernel variables grouped into
 * DATA/VALUES/FUNCTIONS/CLASSES sections with a filter field, two main
 * columns (name | value) and a right-aligned type hint.
 *
 * Row expansion has two tiers. With the Kernels API (test host, Insiders)
 * children come from the inspection snippet, recursively. Without it, the
 * df.info() summary that jupyter.listVariables attaches to DataFrames still
 * yields one level: the columns with their non-null count and dtype.
 *
 * Refreshing costs kernel time (Jupyter runs its introspection script on the
 * kernel), so it is throttled hard: only when the view is visible, only when
 * an execution *ends* (debounced), coalesced to one fetch in flight, and it
 * can be turned off entirely with plotPanel.variablesAutoRefresh.
 *
 * Same doctrine as the plots view otherwise: the webview is a stateless
 * projection, fully re-hydrated on every ready handshake; filtering and
 * section collapsing are ephemeral presentation state, client-side only.
 */

/** What the webview draws: see expandTree for how nested rows are built. */
type VariableRow = PreviewRow;

/** A fetched variable with everything derived from it, computed once. */
interface DecoratedVariable {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly changedAt: number;
  readonly row: VariableRow;
}

interface WebviewSection {
  readonly label: string;
  readonly rows: readonly VariableRow[];
}

type ToVariablesWebviewMessage =
  | {
      readonly type: 'state';
      readonly sections: readonly WebviewSection[];
      readonly target: string | undefined;
      /** Pinned name-column width; undefined lets the view auto-size it. */
      readonly nameWidth: number | undefined;
      /** Pinned type-column width (value|type splitter); undefined = auto. */
      readonly typeWidth: number | undefined;
    }
  | {
      readonly type: 'columnWidths';
      readonly nameWidth: number | undefined;
      readonly typeWidth: number | undefined;
    }
  | { readonly type: 'busy'; readonly busy: boolean }
  | {
      readonly type: 'children';
      readonly requestId: number;
      readonly rows: readonly VariableRow[];
    }
  | { readonly type: 'childrenError'; readonly requestId: number; readonly message: string };

type FromVariablesWebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'refresh' }
  | {
      readonly type: 'expand';
      readonly requestId: number;
      /** Identity in the fallback registry (stable tier). */
      readonly nodeId: string;
      /** Python eval path (kernel tier); '' when not addressable. */
      readonly expression: string;
    }
  | { readonly type: 'openViewer'; readonly expression: string; readonly viewerType: string }
  | { readonly type: 'setNameWidth'; readonly width: number }
  | { readonly type: 'setTypeWidth'; readonly width: number };

/**
 * The exact argument shape jupyter.showDataViewer forwards, untouched, to
 * the contributed viewer (Data Wrangler). Verified by decompilation of
 * Jupyter 2026.6 / Data Wrangler 1.24.2: the viewer only reads name (an
 * identifier or any Python expression — it evaluates it in the kernel
 * itself), type (must be an exact dataTypes member), fileName (Uri of an
 * OPEN notebook, matched by path) and fullType (error text only). frameId
 * or a `variable` key must never be present: they reroute the request down
 * the debugger paths.
 */
interface DataViewerRequest {
  readonly name: string;
  readonly type: string;
  readonly fileName: vscode.Uri;
  readonly value: undefined;
  readonly fullType: undefined;
  readonly supportsDataExplorer: true;
  readonly size: 0;
  readonly shape: '';
  readonly count: 0;
  readonly truncated: true;
}

const REFRESH_DEBOUNCE_MS = 500;
/**
 * How long a listing stays trusted. Flicking between a notebook and a
 * console redraws from the snapshot without troubling the kernel again;
 * anything that actually changes a namespace (an execution ending) refreshes
 * regardless of this.
 */
const FRESH_MS = 3000;

function childRow(child: ChildVariable): VariableRow {
  return {
    name: child.name,
    value: truncate(formatVariableValue(child.type, child.value)),
    typeHint: typeHint(child.type, 0),
    expandable: child.hasChildren,
    expression: child.expression,
    nodeId: child.expression,
    kind: 'variable',
    viewerType: dataViewerType(child.type),
  };
}

/**
 * Functions and classes the user defined in the cells they have run, shaped
 * like kernel variables so they flow through the same decoration path.
 * Jupyter excludes them kernel-side, so the source of the executed cells is
 * the only place left to find them on stable VS Code — which means their
 * value is the signature, not a live object.
 */
function definedInCells(
  notebook: vscode.NotebookDocument,
  since: number | undefined,
): readonly KernelVariable[] {
  const executed = notebook
    .getCells()
    .filter(
      (cell) =>
        cell.kind === vscode.NotebookCellKind.Code &&
        cell.document.languageId === 'python' &&
        cell.executionSummary?.executionOrder !== undefined &&
        // After Clear Variables only cells run since count: execution counts
        // restart at 1 with the kernel, so the end time is what tells.
        (since === undefined || (cell.executionSummary.timing?.endTime ?? 0) > since),
    )
    .sort(
      (left, right) =>
        (left.executionSummary?.executionOrder ?? 0) -
        (right.executionSummary?.executionOrder ?? 0),
    );
  const found = new Map<string, KernelVariable>();
  for (const cell of executed) {
    for (const definition of parsePythonDefinitions(cell.document.getText())) {
      found.set(definition.name, {
        name: definition.name,
        value: definition.signature,
        type: definition.kind === 'function' ? 'function' : 'class',
        expression: definition.name,
        hasNamedChildren: false,
        indexedChildrenCount: 0,
      });
    }
  }
  return [...found.values()];
}

function notebookLabel(notebook: vscode.NotebookDocument): string {
  if (notebook.notebookType === 'interactive') {
    return 'Interactive Window';
  }
  const path = notebook.uri.path;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/**
 * Where the listed variables come from. A notebook kernel can only be read
 * through Jupyter's filtered, truncated descriptions; a console session is a
 * process we own, so it answers with live objects at any depth.
 */
type VariablesTarget =
  | { readonly kind: 'notebook'; readonly notebook: vscode.NotebookDocument }
  | { readonly kind: 'console'; readonly session: ConsoleSession };

function targetKey(target: VariablesTarget): string {
  return target.kind === 'notebook'
    ? target.notebook.uri.toString()
    : `console:${target.session.id}`;
}

function targetLabel(target: VariablesTarget): string {
  return target.kind === 'notebook'
    ? notebookLabel(target.notebook)
    : target.session.label;
}

export class VariablesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'plotPanel.variables';

  private view: vscode.WebviewView | undefined;
  private target: VariablesTarget | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** When Clear Variables last restarted each notebook's kernel (by URI). */
  private readonly clearedAt = new Map<string, number>();
  private inFlight = false;
  private queued = false;
  /** An execution happened while the view was hidden or auto-refresh was off. */
  private stale = false;
  /** Whether the last refresh could ask a live session for children. */
  private kernelExpansion = false;
  /** Last observed state of the active console, to spot an execution ending. */
  private consoleBusy = false;
  /** Last fetch, fully derived; re-grouping/sorting re-projects this cache. */
  private decorated: readonly DecoratedVariable[] = [];
  private targetName: string | undefined;
  /** Stable-tier expansion: repr-parsed preview tables, built on demand. */
  private tree = new ExpandRegistry();
  /**
   * Last rendered state per target. Switching between a notebook and a
   * console then has nothing to wait for: the previous list is redrawn at
   * once and a refresh follows in the background. Asking the kernel first
   * left the view blank for as long as the introspection took.
   */
  private readonly snapshots = new Map<
    string,
    { decorated: readonly DecoratedVariable[]; targetName: string; tree: ExpandRegistry }
  >();
  /** When each source was last listed, for the freshness check. */
  private readonly fetchedAt = new Map<string, number>();
  /**
   * Names that moved during the current run, per source, and how far down the
   * notebook that run has reached. Highlighting accumulates over a run rather
   * than over one listing: during a Run All each cell that ends triggers a
   * listing, and marking only the latest would let every cell erase what the
   * ones before it changed — which is exactly what it used to do.
   */
  private readonly runChanged = new Map<string, Set<string>>();
  private readonly runReached = new Map<string, number>();
  /** Epoch of the source being decorated. */
  private currentRunChanged: ReadonlySet<string> = new Set();
  /** Per-notebook change tracking for the Recent sort (session-scoped). */
  private readonly recency = new Map<string, Map<string, { signature: string; changedAt: number }>>();
  private readonly cancellation = new vscode.CancellationTokenSource();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: JupyterVariablesSource,
    private readonly options: VariablesOptions,
    consoles?: ConsoleSessionManager,
  ) {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    this.target = notebook === undefined ? undefined : { kind: 'notebook', notebook };
    // Grouping/sorting changes re-project the cache; the kernel is not asked.
    const unsubscribeOptions = this.options.onDidChange(() => this.renderFromCache());
    this.disposables.push({ dispose: unsubscribeOptions });
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor !== undefined && !this.targets(editor.notebook)) {
          this.switchTo({ kind: 'notebook', notebook: editor.notebook });
        }
      }),
      // Refresh when an execution *ends* (executionSummary.timing lands),
      // not on every output chunk: a fetch mid-run would queue kernel work
      // behind the running cell and come back stale anyway.
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        const finished = event.cellChanges.some(
          (change) => change.executionSummary?.timing !== undefined,
        );
        if (finished) {
          const key = event.notebook.uri.toString();
          const indices = event.cellChanges
            .filter((change) => change.executionSummary?.timing !== undefined)
            .map((change) => change.cell.index);
          if (startsNewRun(indices, this.runReached.get(key))) {
            this.runChanged.delete(key);
          }
          this.runReached.set(key, Math.max(...indices, this.runReached.get(key) ?? -1));
          this.fetchedAt.delete(key);
          this.target = { kind: 'notebook', notebook: event.notebook };
          if (this.autoRefresh()) {
            this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
          } else {
            this.stale = true;
          }
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor === undefined) {
          return;
        }
        const notebook = this.notebookOf(editor.document);
        if (notebook !== undefined && !this.targets(notebook)) {
          this.switchTo({ kind: 'notebook', notebook });
        }
      }),
      // Clicking a markdown cell, or anywhere that only moves the notebook's
      // selection, changes no text editor — but it is still the user saying
      // which notebook they are working in.
      vscode.window.onDidChangeNotebookEditorSelection((event) => {
        if (!this.targets(event.notebookEditor.notebook)) {
          this.switchTo({ kind: 'notebook', notebook: event.notebookEditor.notebook });
        }
      }),
      vscode.window.onDidChangeNotebookEditorVisibleRanges((event) => {
        if (!this.targets(event.notebookEditor.notebook)) {
          this.switchTo({ kind: 'notebook', notebook: event.notebookEditor.notebook });
        }
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        const key = notebook.uri.toString();
        this.recency.delete(key);
        this.clearedAt.delete(key);
        this.snapshots.delete(key);
        if (this.targets(notebook)) {
          this.switchTo(undefined);
        }
      }),
    );
    if (consoles !== undefined) {
      const unsubscribeConsoles = consoles.onDidChange(() => this.onConsolesChanged(consoles));
      this.disposables.push({ dispose: unsubscribeConsoles });
    }
  }

  private targets(notebook: vscode.NotebookDocument): boolean {
    return this.target?.kind === 'notebook' && this.target.notebook === notebook;
  }

  /**
   * Point the view at another source. The cached rows for that source are
   * drawn immediately, so switching feels instant, and a refresh follows.
   */
  private switchTo(target: VariablesTarget | undefined): void {
    this.target = target;
    if (target === undefined) {
      this.decorated = [];
      this.targetName = undefined;
      this.tree = new ExpandRegistry();
      this.renderFromCache();
      return;
    }
    const snapshot = this.snapshots.get(targetKey(target));
    if (snapshot !== undefined) {
      this.decorated = snapshot.decorated;
      this.targetName = snapshot.targetName;
      this.tree = snapshot.tree;
      this.renderFromCache();
      if (this.isFresh(target)) {
        return;
      }
    }
    this.scheduleRefresh(0);
  }

  /** Called when the console view takes focus: it becomes the source. */
  showConsole(session: ConsoleSession): void {
    if (this.target?.kind === 'console' && this.target.session === session) {
      return;
    }
    this.switchTo({ kind: 'console', session });
  }

  /**
   * Which source is on show follows where the user clicks (see showConsole
   * and the editor listeners); this only keeps the shown console fresh, by
   * refreshing when one of its executions ends. No polling.
   */
  private onConsolesChanged(consoles: ConsoleSessionManager): void {
    const active = consoles.active;
    if (active === undefined) {
      if (this.target?.kind === 'console') {
        this.switchTo(this.activeNotebookTarget());
      }
      return;
    }
    const wasBusy = this.consoleBusy;
    this.consoleBusy = active.state === 'busy';
    if (this.target?.kind !== 'console') {
      return;
    }
    if (this.target.session !== active) {
      this.switchTo({ kind: 'console', session: active });
      return;
    }
    if (wasBusy && active.state === 'idle') {
      this.scheduleRefresh(0);
    }
  }

  private activeNotebookTarget(): VariablesTarget | undefined {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    return notebook === undefined ? undefined : { kind: 'notebook', notebook };
  }

  /**
   * Going back to a notebook cell hands the view back to that notebook.
   * Focusing the console panel does not change the active *notebook* editor,
   * so without this signal the view would stay on the console for good.
   */
  private notebookOf(document: vscode.TextDocument): vscode.NotebookDocument | undefined {
    if (document.uri.scheme !== 'vscode-notebook-cell') {
      return undefined;
    }
    return vscode.workspace.notebookDocuments.find((notebook) =>
      notebook.getCells().some((cell) => cell.document === document),
    );
  }

  private autoRefresh(): boolean {
    return vscode.workspace
      .getConfiguration('plotPanel')
      .get('variablesAutoRefresh', true);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    const subscriptions = [
      view.webview.onDidReceiveMessage((message: FromVariablesWebviewMessage) =>
        this.onMessage(message),
      ),
      view.onDidChangeVisibility(() => {
        if (view.visible && this.stale) {
          void this.refresh();
        }
      }),
    ];
    view.onDidDispose(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Refresh now; resolves when the current fetch cycle completed (test hook). */
  refresh(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    return this.doRefresh();
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.doRefresh();
    }, delay);
  }

  /**
   * Single fetch in flight; a refresh asked for meanwhile runs once after.
   *
   * Only the newest request survives. Switching quickly between sources used
   * to queue one slow kernel round-trip per click — the introspection script
   * runs *on* the kernel, so each can take seconds — and the view showed the
   * result of the last one to finish, long after the click.
   */
  private async doRefresh(): Promise<void> {
    if (this.inFlight) {
      this.queued = true;
      return;
    }
    this.inFlight = true;
    try {
      await this.fetchAndRender();
    } finally {
      this.inFlight = false;
      if (this.queued) {
        this.queued = false;
        void this.doRefresh();
      }
    }
  }

  /** Whether this source was listed recently enough to trust the snapshot. */
  private isFresh(target: VariablesTarget): boolean {
    const at = this.fetchedAt.get(targetKey(target));
    return at !== undefined && Date.now() - at < FRESH_MS;
  }

  private async fetchAndRender(): Promise<void> {
    if (this.view === undefined || !this.view.visible) {
      // Never hit the kernel for a hidden view; catch up when shown again.
      this.stale = true;
      return;
    }
    this.stale = false;
    const target = this.target;
    if (target === undefined) {
      this.tree.clear();
      this.decorated = [];
      this.targetName = undefined;
      this.post({
        type: 'state',
        sections: [],
        target: undefined,
        nameWidth: this.options.nameWidth,
        typeWidth: this.options.typeWidth,
      });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const listed = await this.listFor(target);
    if (this.target !== target) {
      // The user moved on while the kernel was answering: that reply belongs
      // to a source no longer on show.
      this.post({ type: 'busy', busy: false });
      return;
    }
    this.tree = new ExpandRegistry();
    // A console statement is its own unit of work: nothing to accumulate.
    if (target.kind === 'console') {
      this.runChanged.delete(targetKey(target));
    }
    const changed = this.trackRecency(targetKey(target), listed);
    this.currentRunChanged = this.runChanged.get(targetKey(target)) ?? new Set();
    this.decorated = listed.map((variable) =>
      this.decorate(variable, changed.get(variable.name) ?? 0),
    );
    this.targetName = targetLabel(target);
    this.snapshots.set(targetKey(target), {
      decorated: this.decorated,
      targetName: this.targetName,
      tree: this.tree,
    });
    this.fetchedAt.set(targetKey(target), Date.now());
    this.renderFromCache();
  }

  /**
   * List the target's variables, and record whether children can be asked
   * for. A console session is ours, so it always can — and it reports the
   * functions and classes Jupyter filters out kernel-side, which is why only
   * the notebook path needs them recovered from the cell source.
   */
  private async listFor(target: VariablesTarget): Promise<readonly KernelVariable[]> {
    if (target.kind === 'console') {
      this.kernelExpansion = true;
      return target.session.listVariables();
    }
    const notebook = target.notebook;
    const variables = await this.source.listVariables(notebook.uri);
    this.kernelExpansion = variables.length > 0 && (await this.source.canExpand(notebook.uri));
    // A live object always wins over a definition read from the source.
    const live = new Set(variables.map((variable) => variable.name));
    return [
      ...variables,
      ...definedInCells(notebook, this.clearedAt.get(notebook.uri.toString())).filter((definition) => !live.has(definition.name)),
    ];
  }

  /**
   * Update the per-notebook change map: a variable is "recent" when it is
   * new or its signature moved since the previous fetch. The signature
   * includes the DataFrame summary because a mutated wide frame can keep an
   * identical repr head/tail while df.info's counts move.
   */
  private trackRecency(
    uriKey: string,
    variables: readonly KernelVariable[],
  ): ReadonlyMap<string, number> {
    let known = this.recency.get(uriKey);
    if (known === undefined) {
      known = new Map();
      this.recency.set(uriKey, known);
    }
    // On the very first listing everything is "new", which is not news:
    // marking the whole panel would say nothing about what just ran.
    const firstListing = known.size === 0;
    let epoch = this.runChanged.get(uriKey);
    if (epoch === undefined) {
      epoch = new Set();
      this.runChanged.set(uriKey, epoch);
    }
    const now = Date.now();
    const seen = new Set<string>();
    const changedAt = new Map<string, number>();
    for (const variable of variables) {
      seen.add(variable.name);
      const signature = `${variable.type} ${variable.value} ${variable.summary ?? ''}`;
      const previous = known.get(variable.name);
      if (previous === undefined || previous.signature !== signature) {
        known.set(variable.name, { signature, changedAt: now });
        changedAt.set(variable.name, now);
        if (!firstListing) {
          epoch.add(variable.name);
        }
      } else {
        changedAt.set(variable.name, previous.changedAt);
      }
    }
    for (const name of [...known.keys()]) {
      if (!seen.has(name)) {
        known.delete(name);
      }
    }
    return changedAt;
  }

  /** Re-project the cached decorations (grouping/sorting changes, no kernel). */
  private renderFromCache(): void {
    if (this.view === undefined) {
      return;
    }
    const sections = organizeVariables(
      this.decorated,
      this.options.grouping,
      this.options.sorting,
    ).map((section) => ({
      label: section.label,
      rows: section.rows.map((decorated) => decorated.row),
    }));
    this.post({
      type: 'state',
      sections,
      target: this.targetName,
      nameWidth: this.options.nameWidth,
      typeWidth: this.options.typeWidth,
    });
  }

  private decorate(variable: KernelVariable, changedAt: number): DecoratedVariable {
    const expandable = this.kernelExpansion
      ? variable.hasNamedChildren || variable.indexedChildrenCount > 0
      : this.tree.register(variable.name, {
          type: variable.type,
          raw: variable.value,
          summary: variable.summary,
          expression: variable.expression,
        });
    const size = variableSize(variable.type, variable.value, variable.indexedChildrenCount);
    const category = categorize(variable.type);
    // Only constants show a value; a definition shows its signature.
    const showValue =
      isConstant(variable.type, size) || category === 'functions' || category === 'classes';
    return {
      name: variable.name,
      type: variable.type,
      size,
      changedAt,
      row: {
        name: variable.name,
        // A value that moved in this listing is worth pointing out, which is
        // what the Recent sort already tracks.
        ...(this.currentRunChanged.has(variable.name) ? { changed: true } : {}),
        value: showValue ? truncate(formatVariableValue(variable.type, variable.value)) : '',
        typeHint: typeHint(variable.type, 0),
        fullType: variable.type,
        size: sizeLabel(
          variable.type,
          variable.value,
          variable.indexedChildrenCount,
          variable.summary,
        ),
        expandable,
        expression: variable.expression,
        nodeId: variable.name,
        kind: 'variable',
        viewerType: dataViewerType(variable.type),
      },
    };
  }

  private onMessage(message: FromVariablesWebviewMessage): void {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        void this.refresh();
        break;
      case 'expand':
        this.expand(message.requestId, message.nodeId, message.expression);
        break;
      case 'openViewer':
        void this.openViewer(message.expression, message.viewerType);
        break;
      case 'setNameWidth':
        this.options.setNameWidth(message.width);
        break;
      case 'setTypeWidth':
        this.options.setTypeWidth(message.width);
        break;
    }
  }

  /**
   * Empty the session the view is showing.
   *
   * A console is ours, so its namespace is simply reset. A notebook kernel
   * cannot be made to run anything from here — that is the gated API — so the
   * only way to clear it is Jupyter's own restart, which is destructive
   * enough to be worth confirming.
   */
  async clearVariables(): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      return;
    }
    if (target.kind === 'console') {
      target.session.resetNamespace();
      return;
    }
    const confirm = 'Restart Kernel';
    const answer = await vscode.window.showWarningMessage(
      `Clearing the variables of ${notebookLabel(target.notebook)} restarts its kernel: ` +
        'everything it holds is lost.',
      { modal: true },
      confirm,
    );
    if (answer !== confirm) {
      return;
    }
    try {
      await vscode.commands.executeCommand('jupyter.restartkernel');
    } catch {
      void vscode.window.showErrorMessage('Plot Panel: could not restart the notebook kernel.');
      return;
    }
    this.clearedAt.set(target.notebook.uri.toString(), Date.now());
    this.recency.delete(targetKey(target));
    this.fetchedAt.delete(targetKey(target));
    this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
  }

  /** Drop the pinned column widths so they auto-size to their content again. */
  resetColumnWidth(): void {
    this.options.setNameWidth(undefined);
    this.options.setTypeWidth(undefined);
    this.post({ type: 'columnWidths', nameWidth: undefined, typeWidth: undefined });
  }

  private async openViewer(expression: string, viewerType: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      void vscode.window.showErrorMessage(
        'Plot Panel: no active notebook to open the data viewer for.',
      );
      return;
    }
    if (target.kind === 'console') {
      // The delegation resolves the expression against a notebook's kernel;
      // it has no way to reach a session of ours.
      void vscode.window.showErrorMessage(
        'Plot Panel: the Data Viewer works with notebook variables — expand the row to see console data instead.',
      );
      return;
    }
    const request: DataViewerRequest = {
      name: expression,
      type: viewerType,
      fileName: target.notebook.uri,
      value: undefined,
      fullType: undefined,
      supportsDataExplorer: true,
      size: 0,
      shape: '',
      count: 0,
      truncated: true,
    };
    try {
      await vscode.commands.executeCommand('jupyter.showDataViewer', request);
    } catch {
      void vscode.window.showErrorMessage(
        'Plot Panel: could not open the data viewer — is a Jupyter kernel running for this notebook?',
      );
    }
  }

  private expand(requestId: number, nodeId: string, expression: string): void {
    if (!this.kernelExpansion) {
      const rows = this.tree.childrenOf(nodeId);
      if (rows !== undefined) {
        this.post({ type: 'children', requestId, rows });
      } else {
        this.post({
          type: 'childrenError',
          requestId,
          message: 'Could not inspect this variable.',
        });
      }
      return;
    }
    const target = this.target;
    if (target === undefined) {
      this.post({ type: 'childrenError', requestId, message: 'No active session.' });
      return;
    }
    const children =
      target.kind === 'console'
        ? target.session.listChildren(expression)
        : this.source.listChildren(target.notebook.uri, expression, this.cancellation.token);
    void children
      .then((children) => {
        if (children === undefined) {
          this.post({
            type: 'childrenError',
            requestId,
            message: 'Could not inspect this variable.',
          });
        } else {
          this.post({ type: 'children', requestId, rows: children.map(childRow) });
        }
      });
  }

  private post(message: ToVariablesWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'variables.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'variables.css'),
    );
    // Static skeleton only: all dynamic content is built by variables.js
    // through DOM APIs, never through interpolated HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Variables</title>
</head>
<body>
  <header id="filter-row">
    <input id="filter" type="text" placeholder="Filter" aria-label="Filter variables">
  </header>
  <div id="list-wrap">
    <div id="list" role="tree" aria-label="Kernel variables"></div>
    <div id="splitter" role="separator" aria-orientation="vertical"
         aria-label="Resize the name column" tabindex="0"></div>
    <div id="type-splitter" role="separator" aria-orientation="vertical"
         aria-label="Resize the type column" tabindex="0"></div>
  </div>
  <span id="measure" aria-hidden="true"></span>
  <p id="empty" hidden></p>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.cancellation.cancel();
    this.cancellation.dispose();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
