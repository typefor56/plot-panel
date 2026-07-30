import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { ConsoleSessionManager } from './sessionManager';
import type { TranscriptEntry } from './session';

/**
 * The Console view, contributed to the bottom panel next to the terminal.
 *
 * A contributed view exists once per window, so the several sessions live
 * inside this one webview behind a tab bar — the same shape Positron uses.
 * Like the other views here the webview is a stateless projection: the
 * transcript lives in the session and is re-sent in full on every ready
 * handshake.
 */

interface SessionTab {
  readonly id: number;
  readonly label: string;
  readonly state: string;
  readonly active: boolean;
}

type ToConsoleMessage =
  | {
      readonly type: 'state';
      readonly sessions: readonly SessionTab[];
      readonly transcript: readonly TranscriptEntry[];
      readonly prompt: string;
      readonly busy: boolean;
    }
  | { readonly type: 'append'; readonly entry: TranscriptEntry }
  | {
      readonly type: 'sessions';
      readonly sessions: readonly SessionTab[];
      readonly prompt: string;
      readonly busy: boolean;
    };

type FromConsoleMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'execute'; readonly code: string }
  | { readonly type: 'select'; readonly id: number }
  | { readonly type: 'close'; readonly id: number }
  | { readonly type: 'new' };

export class ConsoleViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'plotPanel.console';

  private view: vscode.WebviewView | undefined;
  /** Session whose appends are currently wired to the webview. */
  private followedId: number | undefined;
  private unfollow: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly sessions: ConsoleSessionManager,
  ) {
    const unsubscribe = this.sessions.onDidChange(() => this.syncSessions());
    this.disposables.push({ dispose: unsubscribe });
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    const subscriptions = [
      view.webview.onDidReceiveMessage((message: FromConsoleMessage) =>
        void this.onMessage(message),
      ),
    ];
    view.onDidDispose(() => {
      for (const subscription of subscriptions) {
        subscription.dispose();
      }
      this.unfollow?.();
      this.unfollow = undefined;
      this.followedId = undefined;
      if (this.view === view) {
        this.view = undefined;
      }
    });
  }

  /** Focus the panel and hand it to the caller's command. */
  async reveal(): Promise<void> {
    await vscode.commands.executeCommand('plotPanel.console.focus');
  }

  private async onMessage(message: FromConsoleMessage): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.sendState();
        break;
      case 'execute': {
        const session = await this.sessions.ensureActive();
        session.execute(message.code);
        break;
      }
      case 'select':
        this.sessions.select(message.id);
        break;
      case 'close':
        this.sessions.close(message.id);
        break;
      case 'new':
        await this.sessions.create();
        break;
    }
  }

  private tabs(): readonly SessionTab[] {
    const activeId = this.sessions.active?.id;
    return this.sessions.all.map((session) => ({
      id: session.id,
      label: session.label,
      state: session.state,
      active: session.id === activeId,
    }));
  }

  /** Re-wire the append stream when the active session changes. */
  private follow(): void {
    const active = this.sessions.active;
    if (active?.id === this.followedId) {
      return;
    }
    this.unfollow?.();
    this.unfollow = undefined;
    this.followedId = active?.id;
    if (active !== undefined) {
      this.unfollow = active.onDidAppend((entry) => this.post({ type: 'append', entry }));
    }
  }

  private sendState(): void {
    this.follow();
    const active = this.sessions.active;
    this.post({
      type: 'state',
      sessions: this.tabs(),
      transcript: active?.transcript ?? [],
      prompt: active?.needsMoreInput === true ? '...' : '>>>',
      busy: active?.state === 'busy',
    });
  }

  private syncSessions(): void {
    const changedSession = this.sessions.active?.id !== this.followedId;
    if (changedSession) {
      // A different session means a different transcript entirely.
      this.sendState();
      return;
    }
    const active = this.sessions.active;
    this.post({
      type: 'sessions',
      sessions: this.tabs(),
      prompt: active?.needsMoreInput === true ? '...' : '>>>',
      busy: active?.state === 'busy',
    });
  }

  /** Refresh the whole transcript (used after clear/restart). */
  refresh(): void {
    this.sendState();
  }

  private post(message: ToConsoleMessage): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'console.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, 'media', 'console.css'),
    );
    // Static skeleton only: all dynamic content is built by console.js
    // through DOM APIs, never through interpolated HTML.
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>Console</title>
</head>
<body>
  <nav id="tabs" aria-label="Console sessions"></nav>
  <div id="scrollback" role="log" aria-live="polite" aria-label="Console output"></div>
  <div id="input-row">
    <span id="prompt" aria-hidden="true">&gt;&gt;&gt;</span>
    <textarea id="input" rows="1" spellcheck="false" autocomplete="off"
              aria-label="Python input"></textarea>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  dispose(): void {
    this.unfollow?.();
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
  }
}
