import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import { categorize, typeHint, groupAndSort, type VariableCategory } from './categorize';
import type { ChildVariable } from './inspect';
import type { JupyterVariablesSource, KernelVariable } from './jupyterApi';

/**
 * The Jupyter Variables webview view: kernel variables grouped into
 * DATA/VALUES/FUNCTIONS/CLASSES sections with a filter field, two main
 * columns (name | value) and a right-aligned type hint. Rows expand into
 * children when the Kernels API is available (see jupyterApi.ts).
 *
 * Same doctrine as the plots view: the webview is a stateless projection,
 * fully re-hydrated on every ready handshake; filtering and section
 * collapsing are ephemeral presentation state, client-side only.
 */

interface VariableRow {
  readonly name: string;
  readonly value: string;
  readonly typeHint: string;
  readonly category: VariableCategory;
  readonly expandable: boolean;
  /** Eval path for children; equals the (bracket-safe) name at top level. */
  readonly expression: string;
}

type ToVariablesWebviewMessage =
  | {
      readonly type: 'state';
      readonly rows: readonly VariableRow[];
      readonly expandable: boolean;
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
const VALUE_CAP = 200;

function truncate(value: string): string {
  return value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP - 1)}…` : value;
}

function topLevelRow(variable: KernelVariable): VariableRow {
  return {
    name: variable.name,
    value: truncate(variable.value),
    typeHint: typeHint(variable.type, variable.indexedChildrenCount),
    category: categorize(variable.type),
    expandable: variable.hasNamedChildren || variable.indexedChildrenCount > 0,
    expression: variable.name,
  };
}

function childRow(child: ChildVariable): VariableRow {
  return {
    name: child.name,
    value: truncate(child.value),
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
  private refreshSeq = 0;
  private pendingRefresh: Promise<void> = Promise.resolve();
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
      // Variables change when cells execute; outputs/executionSummary changes
      // are the execution signal (the capture module keys on the same event).
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        const executed = event.cellChanges.some(
          (change) => change.outputs !== undefined || change.executionSummary !== undefined,
        );
        if (executed) {
          this.target = event.notebook;
          this.scheduleRefresh(REFRESH_DEBOUNCE_MS);
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    const messageSubscription = view.webview.onDidReceiveMessage(
      (message: FromVariablesWebviewMessage) => this.onMessage(message),
    );
    view.onDidDispose(() => {
      messageSubscription.dispose();
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Refresh now; resolves when the fetch cycle has completed (test hook). */
  refresh(): Promise<void> {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.pendingRefresh = this.doRefresh();
    return this.pendingRefresh;
  }

  private scheduleRefresh(delay: number): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, delay);
  }

  private async doRefresh(): Promise<void> {
    const seq = ++this.refreshSeq;
    if (this.view === undefined) {
      return;
    }
    const target = this.target;
    if (target === undefined) {
      this.post({ type: 'state', rows: [], expandable: false, target: undefined });
      return;
    }
    this.post({ type: 'busy', busy: true });
    const variables = await this.source.listVariables(target.uri);
    if (seq !== this.refreshSeq) {
      return; // superseded by a newer refresh
    }
    const expandable = variables.length > 0 && (await this.source.canExpand(target.uri));
    if (seq !== this.refreshSeq) {
      return;
    }
    const rows: VariableRow[] = [];
    for (const group of groupAndSort(variables).values()) {
      for (const variable of group) {
        rows.push(topLevelRow(variable));
      }
    }
    this.post({ type: 'state', rows, expandable, target: targetLabel(target) });
  }

  private onMessage(message: FromVariablesWebviewMessage): void {
    switch (message.type) {
      case 'ready':
      case 'refresh':
        void this.refresh();
        break;
      case 'expand': {
        const target = this.target;
        if (target === undefined) {
          this.post({
            type: 'childrenError',
            requestId: message.requestId,
            message: 'No active notebook.',
          });
          break;
        }
        void this.source
          .listChildren(target.uri, message.expression, this.cancellation.token)
          .then((children) => {
            if (children === undefined) {
              this.post({
                type: 'childrenError',
                requestId: message.requestId,
                message: 'Could not inspect this variable.',
              });
            } else {
              this.post({
                type: 'children',
                requestId: message.requestId,
                rows: children.map(childRow),
              });
            }
          });
        break;
      }
    }
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
