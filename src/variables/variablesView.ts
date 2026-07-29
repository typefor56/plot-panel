import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import {
  categorize,
  formatVariableValue,
  typeHint,
  groupAndSort,
  type VariableCategory,
} from './categorize';
import type { ChildVariable } from './inspect';
import type { JupyterVariablesSource, KernelVariable } from './jupyterApi';
import { parseDataFrameSummary } from './summary';

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
  readonly category: VariableCategory;
  readonly expandable: boolean;
  /** Eval path for children; equals the name at top level. */
  readonly expression: string;
}

type ToVariablesWebviewMessage =
  | {
      readonly type: 'state';
      readonly rows: readonly VariableRow[];
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
  | { readonly type: 'expand'; readonly requestId: number; readonly expression: string };

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
    category: 'values',
    expandable: child.hasChildren,
    expression: child.expression,
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
  /** Stable fallback: DataFrame columns parsed from df.info(), by expression. */
  private readonly summaryChildren = new Map<string, readonly VariableRow[]>();
  private readonly cancellation = new vscode.CancellationTokenSource();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly source: JupyterVariablesSource,
  ) {
    this.target = vscode.window.activeNotebookEditor?.notebook;
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
      this.summaryChildren.clear();
      this.post({ type: 'state', rows: [], target: undefined });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const variables = await this.source.listVariables(target.uri);
    this.kernelExpansion = variables.length > 0 && (await this.source.canExpand(target.uri));
    this.summaryChildren.clear();
    const rows: VariableRow[] = [];
    for (const group of groupAndSort(variables).values()) {
      for (const variable of group) {
        rows.push(this.topLevelRow(variable));
      }
    }
    this.post({ type: 'state', rows, target: targetLabel(target) });
  }

  private topLevelRow(variable: KernelVariable): VariableRow {
    let expandable = false;
    if (this.kernelExpansion) {
      expandable = variable.hasNamedChildren || variable.indexedChildrenCount > 0;
    } else if (variable.summary !== undefined) {
      const columns = parseDataFrameSummary(variable.summary);
      if (columns !== undefined) {
        this.summaryChildren.set(
          variable.expression,
          columns.map((column) => ({
            name: column.name,
            value: column.nonNull,
            typeHint: column.dtype,
            category: 'values',
            expandable: false,
            expression: `${variable.expression}[${JSON.stringify(column.name)}]`,
          })),
        );
        expandable = true;
      }
    }
    return {
      name: variable.name,
      value: truncate(formatVariableValue(variable.type, variable.value)),
      typeHint: typeHint(variable.type, variable.indexedChildrenCount),
      category: categorize(variable.type),
      expandable,
      expression: variable.expression,
    };
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
    }
  }

  private expand(requestId: number, expression: string): void {
    if (!this.kernelExpansion) {
      const columns = this.summaryChildren.get(expression);
      if (columns !== undefined) {
        this.post({ type: 'children', requestId, rows: columns });
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
