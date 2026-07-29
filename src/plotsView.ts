import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { HistoryEvent, PlotHistory } from './history';
import type { PlotEntry } from './types';

/**
 * The Plots webview view: current figure on top, clickable thumbnail strip at
 * the bottom. The history model is the single source of truth; the webview is
 * a projection kept in sync through messages, and fully re-hydrated on every
 * resolve (WebviewView has no retainContextWhenHidden — the webview is
 * destroyed whenever the view is hidden).
 */

interface WebviewEntry {
  readonly id: string;
  readonly mime: string;
  readonly dataUri: string;
  readonly source: string;
  readonly timestamp: number;
}

type ToWebviewMessage =
  | {
      readonly type: 'state';
      readonly entries: readonly WebviewEntry[];
      readonly selectedId: string | undefined;
      readonly notice: string | undefined;
    }
  | { readonly type: 'added'; readonly entry: WebviewEntry }
  | { readonly type: 'evicted'; readonly ids: readonly string[] }
  | { readonly type: 'selected'; readonly id: string | undefined }
  | { readonly type: 'cleared' }
  | { readonly type: 'notice'; readonly text: string };

type FromWebviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'select'; readonly id: string }
  | { readonly type: 'nav'; readonly direction: 'previous' | 'next' };

function toWebviewEntry(entry: PlotEntry): WebviewEntry {
  return {
    id: entry.id,
    mime: entry.mime,
    dataUri: `data:${entry.mime};base64,${Buffer.from(entry.data).toString('base64')}`,
    source: entry.source,
    timestamp: entry.timestamp,
  };
}

export class PlotsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'plotPanel.plots';

  private view: vscode.WebviewView | undefined;
  private notice: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: PlotHistory,
  ) {
    const unsubscribe = this.history.onDidChange((event) => this.onHistoryEvent(event));
    this.disposables.push(new vscode.Disposable(unsubscribe));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((message: FromWebviewMessage) => this.onMessage(message)),
    );
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Bring the view on screen without stealing focus (used by autoReveal). */
  async reveal(): Promise<void> {
    if (this.view !== undefined) {
      this.view.show(true);
      return;
    }
    // The view has never been resolved: the generated focus command is the
    // only stable way to force-open it.
    await vscode.commands.executeCommand(`${PlotsViewProvider.viewType}.focus`);
  }

  /** Explicit message for outputs that cannot be captured (interactive widgets). */
  showNotice(text: string): void {
    this.notice = text;
    this.post({ type: 'notice', text });
  }

  private onHistoryEvent(event: HistoryEvent): void {
    switch (event.type) {
      case 'added':
        this.notice = undefined;
        this.post({ type: 'added', entry: toWebviewEntry(event.entry) });
        break;
      case 'evicted':
        this.post({ type: 'evicted', ids: event.ids });
        break;
      case 'selected':
        this.post({ type: 'selected', id: event.id });
        break;
      case 'cleared':
        this.notice = undefined;
        this.post({ type: 'cleared' });
        break;
    }
  }

  private onMessage(message: FromWebviewMessage): void {
    switch (message.type) {
      case 'ready':
        this.post({
          type: 'state',
          entries: this.history.entries.map(toWebviewEntry),
          selectedId: this.history.selected?.id,
          notice: this.notice,
        });
        break;
      case 'select':
        this.history.select(message.id);
        break;
      case 'nav':
        if (message.direction === 'previous') {
          this.history.previous();
        } else {
          this.history.next();
        }
        break;
    }
  }

  private post(message: ToWebviewMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'main.css'),
    );
    // Static skeleton only: all dynamic content is built by main.js through
    // DOM APIs, never through interpolated HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; img-src data:; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Plots</title>
</head>
<body>
  <main id="stage">
    <img id="figure" alt="Current plot" hidden>
    <p id="empty">No plots yet. Figures from notebooks and the Interactive Window appear here automatically.</p>
  </main>
  <p id="notice" role="status" hidden></p>
  <nav id="strip" role="listbox" aria-label="Plot history" hidden></nav>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
