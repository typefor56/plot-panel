import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  dataViewerType,
  formatVariableValue,
  organizeVariables,
  typeHint,
  variableCount,
  variableSize,
} from './categorize';
import type { ChildVariable } from './inspect';
import type { JupyterVariablesSource, KernelVariable } from './jupyterApi';
import type { ConsoleSession } from '../console/session';
import type { ConsoleSessionManager } from '../console/sessionManager';
import { canExpandRepr, inferChildType, qualifiedType } from './childType';
import {
  type DataFrameGrid,
  parseCollectionRepr,
  parseDataFrameRepr,
  parseSeriesRepr,
  splitDictItem,
} from './reprParse';
import { parsePythonDefinitions } from './pythonDefs';
import { parseDataFrameSummary } from './summary';
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

interface VariableRow {
  readonly name: string;
  readonly value: string;
  readonly typeHint: string;
  readonly expandable: boolean;
  /** Eval path for children; equals the name at top level. */
  readonly expression: string;
  /**
   * Identity of this row in the fallback node registry. Synthetic, because a
   * Series index or a set element has no addressable Python expression while
   * still being expandable from its repr.
   */
  readonly nodeId: string;
  /** 'ellipsis' renders the truncation marker row of a preview table. */
  readonly kind: 'variable' | 'ellipsis';
  /** Set when the row can open in the data viewer (wired separately). */
  readonly viewerType: string | undefined;
}

const ELLIPSIS_ROW: VariableRow = {
  name: '',
  value: '⋯',
  typeHint: '',
  expandable: false,
  expression: '',
  nodeId: '',
  kind: 'ellipsis',
  viewerType: undefined,
};

/**
 * A value we know how to look inside, kept by id so its children can be
 * parsed on demand and registered in turn — that is what makes expansion
 * recursive rather than a fixed two levels.
 */
interface FallbackNode {
  readonly type: string;
  readonly raw: string;
  /** df.info() text, for top-level DataFrames only. */
  readonly summary: string | undefined;
  /** Python eval path, '' when the value is not addressable. */
  readonly expression: string;
}

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
    }
  | { readonly type: 'nameWidth'; readonly width: number | undefined }
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
  | { readonly type: 'setNameWidth'; readonly width: number };

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
const VALUE_CAP = 80;

function truncate(value: string): string {
  return value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP - 1)}…` : value;
}

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

function shortType(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot === -1 ? type : type.slice(dot + 1);
}

const INDEXED_TYPES = new Set(['list', 'tuple', 'set', 'frozenset', 'ndarray']);

/**
 * Rebuild one column of a parsed grid as a Series repr, so the generic
 * Series branch can turn it into an index | value table. Keeps a single code
 * path for "look inside a column" and "look inside a Series".
 */
function synthesizeSeries(
  grid: DataFrameGrid,
  column: number,
  dtype: string | undefined,
): string {
  const lines = grid.rows.map((row) => `${row.index}  ${row.cells[column] ?? ''}`);
  if (grid.gapAt !== undefined) {
    lines.splice(grid.gapAt, 0, '..');
  }
  lines.push(`dtype: ${dtype ?? 'object'}`);
  return lines.join('\n');
}

/**
 * Functions and classes the user defined in the cells they have run, shaped
 * like kernel variables so they flow through the same decoration path.
 * Jupyter excludes them kernel-side, so the source of the executed cells is
 * the only place left to find them on stable VS Code — which means their
 * value is the signature, not a live object.
 */
function definedInCells(notebook: vscode.NotebookDocument): readonly KernelVariable[] {
  const executed = notebook
    .getCells()
    .filter(
      (cell) =>
        cell.kind === vscode.NotebookCellKind.Code &&
        cell.document.languageId === 'python' &&
        cell.executionSummary?.executionOrder !== undefined,
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
  /**
   * Stable-tier expansion. Every value we know how to look inside is a node;
   * its children are parsed from its repr the first time it is expanded and
   * registered as nodes themselves, so the depth is bounded only by what the
   * repr still shows, not by a hard-coded number of levels.
   */
  private readonly nodes = new Map<string, FallbackNode>();
  private readonly childCache = new Map<string, readonly VariableRow[]>();
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
          this.target = { kind: 'notebook', notebook: editor.notebook };
          this.scheduleRefresh(0);
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
          this.target = { kind: 'notebook', notebook: event.notebook };
          if (this.autoRefresh()) {
            this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
          } else {
            this.stale = true;
          }
        }
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        this.recency.delete(notebook.uri.toString());
        if (this.targets(notebook)) {
          this.target = undefined;
          this.scheduleRefresh(0);
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
   * Running something in a console makes it the session on show — the same
   * rule as a notebook, whose executions already claim the view. Its own
   * completion is what triggers the refresh: no polling.
   */
  private onConsolesChanged(consoles: ConsoleSessionManager): void {
    const active = consoles.active;
    if (active === undefined) {
      if (this.target?.kind === 'console') {
        this.target = undefined;
        this.scheduleRefresh(0);
      }
      return;
    }
    const wasBusy = this.consoleBusy;
    this.consoleBusy = active.state === 'busy';
    if (this.target?.kind !== 'console' || this.target.session !== active) {
      this.target = { kind: 'console', session: active };
      this.scheduleRefresh(0);
      return;
    }
    if (wasBusy && active.state === 'idle') {
      this.scheduleRefresh(0);
    }
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

  /** Single fetch in flight; a refresh requested meanwhile runs once after. */
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

  private async fetchAndRender(): Promise<void> {
    if (this.view === undefined || !this.view.visible) {
      // Never hit the kernel for a hidden view; catch up when shown again.
      this.stale = true;
      return;
    }
    this.stale = false;
    const target = this.target;
    if (target === undefined) {
      this.clearNodes();
      this.decorated = [];
      this.targetName = undefined;
      this.post({
        type: 'state',
        sections: [],
        target: undefined,
        nameWidth: this.options.nameWidth,
      });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const listed = await this.listFor(target);
    this.clearNodes();
    const changed = this.trackRecency(targetKey(target), listed);
    this.decorated = listed.map((variable) =>
      this.decorate(variable, changed.get(variable.name) ?? 0),
    );
    this.targetName = targetLabel(target);
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
      ...definedInCells(notebook).filter((definition) => !live.has(definition.name)),
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
    });
  }

  private decorate(variable: KernelVariable, changedAt: number): DecoratedVariable {
    const expandable = this.kernelExpansion
      ? variable.hasNamedChildren || variable.indexedChildrenCount > 0
      : this.registerNode(variable.name, {
          type: variable.type,
          raw: variable.value,
          summary: variable.summary,
          expression: variable.expression,
        });
    const count = variableCount(variable.type, variable.value, variable.indexedChildrenCount);
    return {
      name: variable.name,
      type: variable.type,
      size: variableSize(variable.type, variable.value, variable.indexedChildrenCount),
      changedAt,
      row: {
        name: variable.name,
        value: truncate(formatVariableValue(variable.type, variable.value)),
        typeHint: typeHint(variable.type, count),
        expandable,
        expression: variable.expression,
        nodeId: variable.name,
        kind: 'variable',
        viewerType: dataViewerType(variable.type),
      },
    };
  }

  private clearNodes(): void {
    this.nodes.clear();
    this.childCache.clear();
  }

  /** Remember a value we may be asked to look inside; says if we can. */
  private registerNode(nodeId: string, node: FallbackNode): boolean {
    this.nodes.set(nodeId, node);
    return canExpandRepr(node.type, node.raw, node.summary);
  }

  /** Children of a registered node, parsed once and memoized. */
  private childRowsOf(nodeId: string): readonly VariableRow[] | undefined {
    const cached = this.childCache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const node = this.nodes.get(nodeId);
    if (node === undefined) {
      return undefined;
    }
    const short = shortType(node.type);
    let rows: readonly VariableRow[] | undefined;
    if (short === 'DataFrame') {
      rows = this.dataFrameChildren(nodeId, node);
    } else if (short === 'Series') {
      rows = this.seriesChildren(nodeId, node);
    } else if (short === 'dict') {
      rows = this.dictChildren(nodeId, node);
    } else if (INDEXED_TYPES.has(short)) {
      rows = this.itemChildren(nodeId, node, short);
    }
    if (rows !== undefined) {
      this.childCache.set(nodeId, rows);
    }
    return rows;
  }

  /**
   * One row for a nested value, typed by inference from its own repr and
   * registered as a node so it can be expanded in turn.
   */
  private nestedRow(
    parentId: string,
    position: number,
    name: string,
    raw: string,
    expression: string,
  ): VariableRow {
    const nodeId = `${parentId}#${position}`;
    const type = qualifiedType(inferChildType(raw));
    const expandable = this.registerNode(nodeId, {
      type,
      raw,
      summary: undefined,
      expression,
    });
    return {
      name,
      value: truncate(
        type.length > 0 ? formatVariableValue(type, raw) : raw.replace(/\s+/g, ' ').trim(),
      ),
      typeHint: type.length > 0 ? typeHint(type, 0) : '',
      expandable,
      expression,
      nodeId,
      kind: 'variable',
      viewerType: expression.length > 0 ? dataViewerType(type) : undefined,
    };
  }

  /**
   * A DataFrame lists its columns: names and non-null counts from df.info()
   * when Jupyter attached it, otherwise from the repr grid alone (which is
   * the case for a frame nested inside another value).
   */
  private dataFrameChildren(
    nodeId: string,
    node: FallbackNode,
  ): readonly VariableRow[] | undefined {
    const columns = node.summary !== undefined ? parseDataFrameSummary(node.summary) : undefined;
    const grid = parseDataFrameRepr(node.raw);
    const names = columns?.map((column) => column.name) ?? grid?.columns;
    if (names === undefined) {
      return undefined;
    }
    const rows: VariableRow[] = [];
    names.forEach((name, position) => {
      // pandas prints a literal "..." column past its display limit.
      if (name === '...') {
        return;
      }
      const info = columns?.[position];
      const childId = `${nodeId}#${position}`;
      const expression =
        node.expression.length > 0 ? `${node.expression}[${JSON.stringify(name)}]` : '';
      const gridIndex = grid?.columns.indexOf(name) ?? -1;
      const raw =
        grid !== undefined && gridIndex !== -1
          ? synthesizeSeries(grid, gridIndex, info?.dtype)
          : '';
      const expandable = this.registerNode(childId, {
        type: 'pandas.Series',
        raw,
        summary: undefined,
        expression,
      });
      rows.push({
        name,
        value: info?.nonNull ?? truncate(formatVariableValue('pandas.Series', raw)),
        typeHint: info?.dtype ?? 'pandas.Series',
        expandable,
        expression,
        nodeId: childId,
        kind: 'variable',
        // A DataFrame column evaluates to a Series; the viewer accepts the
        // expression as its name and resolves it in the kernel.
        ...(expression.length > 0 ? { viewerType: 'Series' } : { viewerType: undefined }),
      });
    });
    return rows.length > 0 ? rows : undefined;
  }

  private seriesChildren(nodeId: string, node: FallbackNode): readonly VariableRow[] | undefined {
    const parsed = parseSeriesRepr(node.raw);
    if (parsed === undefined || parsed.pairs.length === 0) {
      return undefined;
    }
    // No expression for a label: an index is not reliably addressable
    // (integer labels, datetimes, duplicates), and a wrong one would open
    // the wrong data in the viewer.
    const rows = parsed.pairs.map(([index, value], position) =>
      this.nestedRow(nodeId, position, index, value, ''),
    );
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
  }

  private dictChildren(nodeId: string, node: FallbackNode): readonly VariableRow[] | undefined {
    const parsed = parseCollectionRepr(node.raw, 'dict');
    if (parsed === undefined || parsed.items.length === 0) {
      return undefined;
    }
    const rows = parsed.items.map((item, position) => {
      const split = splitDictItem(item);
      if (split === undefined) {
        return this.nestedRow(nodeId, position, String(position), item, '');
      }
      // The parsed key is already a Python literal, so d[<key>] is valid.
      const expression =
        node.expression.length > 0 ? `${node.expression}[${split[0]}]` : '';
      return this.nestedRow(nodeId, position, split[0], split[1], expression);
    });
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
  }

  private itemChildren(
    nodeId: string,
    node: FallbackNode,
    short: string,
  ): readonly VariableRow[] | undefined {
    const parsed = parseCollectionRepr(node.raw, short);
    if (parsed === undefined || parsed.items.length === 0) {
      return undefined;
    }
    const unordered = short === 'set' || short === 'frozenset';
    const rows = parsed.items.map((item, position) => {
      // Positions after a mid-repr gap (numpy) are unknown: leave them blank.
      const known = parsed.gapAt === undefined || position < parsed.gapAt;
      const addressable = known && !unordered && node.expression.length > 0;
      return this.nestedRow(
        nodeId,
        position,
        known && !unordered ? String(position) : '',
        item,
        addressable ? `${node.expression}[${position}]` : '',
      );
    });
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
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
    }
  }

  /** Drop the pinned column width so it auto-sizes to the longest name again. */
  resetColumnWidth(): void {
    this.options.setNameWidth(undefined);
    this.post({ type: 'nameWidth', width: undefined });
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
      const rows = this.childRowsOf(nodeId);
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
