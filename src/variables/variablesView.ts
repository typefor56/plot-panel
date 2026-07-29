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
import {
  parseCollectionRepr,
  parseDataFrameRepr,
  parseSeriesRepr,
  splitDictItem,
} from './reprParse';
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
  kind: 'ellipsis',
  viewerType: undefined,
};

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
  | { readonly type: 'expand'; readonly requestId: number; readonly expression: string }
  | { readonly type: 'openViewer'; readonly expression: string; readonly viewerType: string };

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
    kind: 'variable',
    viewerType: dataViewerType(child.type),
  };
}

/** One index | value line of a preview table (never expandable). */
function tableRow(name: string, value: string): VariableRow {
  return {
    name,
    value: truncate(value),
    typeHint: '',
    expandable: false,
    expression: '',
    kind: 'variable',
    viewerType: undefined,
  };
}

function targetLabel(notebook: vscode.NotebookDocument): string {
  if (notebook.notebookType === 'interactive') {
    return 'Interactive Window';
  }
  const path = notebook.uri.path;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

export class VariablesViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'plotPanel.variables';

  private view: vscode.WebviewView | undefined;
  private target: vscode.NotebookDocument | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private inFlight = false;
  private queued = false;
  /** An execution happened while the view was hidden or auto-refresh was off. */
  private stale = false;
  /** Whether the last refresh could use the Kernels API for expansion. */
  private kernelExpansion = false;
  /** Last fetch, fully derived; re-grouping/sorting re-projects this cache. */
  private decorated: readonly DecoratedVariable[] = [];
  private targetName: string | undefined;
  /**
   * Stable-tier expansion: preview tables and column lists parsed from the
   * reprs/df.info at decorate time, keyed by expression (levels 1 and 2).
   */
  private readonly fallbackChildren = new Map<string, readonly VariableRow[]>();
  /** Per-notebook change tracking for the Recent sort (session-scoped). */
  private readonly recency = new Map<string, Map<string, { signature: string; changedAt: number }>>();
  private readonly cancellation = new vscode.CancellationTokenSource();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: JupyterVariablesSource,
    private readonly options: VariablesOptions,
  ) {
    this.target = vscode.window.activeNotebookEditor?.notebook;
    // Grouping/sorting changes re-project the cache; the kernel is not asked.
    const unsubscribeOptions = this.options.onDidChange(() => this.renderFromCache());
    this.disposables.push({ dispose: unsubscribeOptions });
    this.disposables.push(
      vscode.window.onDidChangeActiveNotebookEditor((editor) => {
        if (editor !== undefined && editor.notebook !== this.target) {
          this.target = editor.notebook;
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
          this.target = event.notebook;
          if (this.autoRefresh()) {
            this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
          } else {
            this.stale = true;
          }
        }
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        this.recency.delete(notebook.uri.toString());
        if (this.target === notebook) {
          this.target = undefined;
          this.scheduleRefresh(0);
        }
      }),
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
      this.fallbackChildren.clear();
      this.decorated = [];
      this.targetName = undefined;
      this.post({ type: 'state', sections: [], target: undefined });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const variables = await this.source.listVariables(target.uri);
    this.kernelExpansion = variables.length > 0 && (await this.source.canExpand(target.uri));
    this.fallbackChildren.clear();
    const changed = this.trackRecency(target.uri.toString(), variables);
    this.decorated = variables.map((variable) =>
      this.decorate(variable, changed.get(variable.name) ?? 0),
    );
    this.targetName = targetLabel(target);
    this.renderFromCache();
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
    this.post({ type: 'state', sections, target: this.targetName });
  }

  private decorate(variable: KernelVariable, changedAt: number): DecoratedVariable {
    const expandable = this.kernelExpansion
      ? variable.hasNamedChildren || variable.indexedChildrenCount > 0
      : this.buildFallback(variable);
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
        kind: 'variable',
        viewerType: dataViewerType(variable.type),
      },
    };
  }

  /**
   * Stable tier: precompute this variable's expansion from what the reprs
   * and df.info already show. Returns whether the row is expandable.
   * Everything lands in fallbackChildren, keyed by expression:
   * - DataFrame → its columns (level 1), each column with its own
   *   index | value preview table (level 2) when the repr grid parsed;
   * - Series → index | value pairs;
   * - list/tuple/set/ndarray → position | item; dict → key | value.
   */
  private buildFallback(variable: KernelVariable): boolean {
    const type = variable.type;
    const short = type.slice(type.lastIndexOf('.') + 1);
    if (short === 'DataFrame') {
      const columns =
        variable.summary !== undefined ? parseDataFrameSummary(variable.summary) : undefined;
      if (columns === undefined) {
        return false;
      }
      const grid = parseDataFrameRepr(variable.value);
      const columnRows = columns.map((column): VariableRow => {
        const expression = `${variable.expression}[${JSON.stringify(column.name)}]`;
        let expandable = false;
        const gridIndex = grid?.columns.indexOf(column.name) ?? -1;
        if (grid !== undefined && gridIndex !== -1 && column.name !== '...') {
          const table = grid.rows.map((row) => tableRow(row.index, row.cells[gridIndex] ?? ''));
          if (grid.gapAt !== undefined) {
            table.splice(grid.gapAt, 0, ELLIPSIS_ROW);
          }
          this.fallbackChildren.set(expression, table);
          expandable = true;
        }
        return {
          name: column.name,
          value: column.nonNull,
          typeHint: column.dtype,
          expandable,
          expression,
          kind: 'variable',
          // A DataFrame column evaluates to a Series; the viewer accepts
          // the expression as its name and resolves it in the kernel.
          viewerType: 'Series',
        };
      });
      this.fallbackChildren.set(variable.expression, columnRows);
      return true;
    }
    if (short === 'Series') {
      const parsed = parseSeriesRepr(variable.value);
      if (parsed === undefined || parsed.pairs.length === 0) {
        return false;
      }
      const table = parsed.pairs.map(([index, value]) => tableRow(index, value));
      if (parsed.gapAt !== undefined) {
        table.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
      }
      this.fallbackChildren.set(variable.expression, table);
      return true;
    }
    if (short === 'dict') {
      const parsed = parseCollectionRepr(variable.value, short);
      if (parsed === undefined || parsed.items.length === 0) {
        return false;
      }
      const table = parsed.items.map((item, position) => {
        const split = splitDictItem(item);
        return split === undefined ? tableRow(String(position), item) : tableRow(split[0], split[1]);
      });
      if (parsed.gapAt !== undefined) {
        table.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
      }
      this.fallbackChildren.set(variable.expression, table);
      return true;
    }
    if (
      short === 'list' ||
      short === 'tuple' ||
      short === 'set' ||
      short === 'frozenset' ||
      short === 'ndarray'
    ) {
      const parsed = parseCollectionRepr(variable.value, short);
      if (parsed === undefined || parsed.items.length === 0) {
        return false;
      }
      // Positions after a mid-repr gap (numpy) are unknown: leave them blank.
      const table = parsed.items.map((item, position) =>
        tableRow(parsed.gapAt === undefined || position < parsed.gapAt ? String(position) : '', item),
      );
      if (parsed.gapAt !== undefined) {
        table.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
      }
      this.fallbackChildren.set(variable.expression, table);
      return true;
    }
    return false;
  }

  private onMessage(message: FromVariablesWebviewMessage): void {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        void this.refresh();
        break;
      case 'expand':
        this.expand(message.requestId, message.expression);
        break;
      case 'openViewer':
        void this.openViewer(message.expression, message.viewerType);
        break;
    }
  }

  private async openViewer(expression: string, viewerType: string): Promise<void> {
    const target = this.target;
    if (target === undefined) {
      void vscode.window.showErrorMessage(
        'Plot Panel: no active notebook to open the data viewer for.',
      );
      return;
    }
    const request: DataViewerRequest = {
      name: expression,
      type: viewerType,
      fileName: target.uri,
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

  private expand(requestId: number, expression: string): void {
    if (!this.kernelExpansion) {
      const rows = this.fallbackChildren.get(expression);
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
      this.post({ type: 'childrenError', requestId, message: 'No active notebook.' });
      return;
    }
    void this.source
      .listChildren(target.uri, expression, this.cancellation.token)
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
  <title>Jupyter Variables</title>
</head>
<body>
  <header id="filter-row">
    <input id="filter" type="text" placeholder="Filter" aria-label="Filter variables">
  </header>
  <div id="list" role="tree" aria-label="Kernel variables"></div>
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
