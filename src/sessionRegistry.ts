import * as vscode from 'vscode';
import type { PlotHistory } from './history';
import type { PlotWebviewSession, SessionHost } from './webviewSession';

/**
 * Tracks every live plot webview session (sidebar view, gallery panel, pinned
 * plot panels) so cross-cutting concerns fan out once: the sticky widget
 * notice is broadcast to gallery surfaces and survives re-hydration here, not
 * in any individual view.
 */
export class SessionRegistry implements vscode.Disposable, SessionHost {
  private readonly sessions = new Set<PlotWebviewSession>();
  private lastNotice: string | undefined;
  private readonly unsubscribe: () => void;

  constructor(history: PlotHistory) {
    // The notice describes the latest kernel output; a new capture or a clear
    // supersedes it, mirroring what the webviews do client-side.
    this.unsubscribe = history.onDidChange((event) => {
      if (event.type === 'added' || event.type === 'cleared') {
        this.lastNotice = undefined;
      }
    });
  }

  /** Sticky notice re-shown to gallery sessions on re-hydration. */
  get notice(): string | undefined {
    return this.lastNotice;
  }

  /** Track a session until it is disposed. */
  add(session: PlotWebviewSession): void {
    this.sessions.add(session);
    session.onDidDispose(() => this.sessions.delete(session));
  }

  /** Show a notice in every gallery session (single sessions stay pinned and quiet). */
  broadcastNotice(text: string): void {
    this.lastNotice = text;
    for (const session of this.sessions) {
      if (session.mode === 'gallery') {
        session.showNotice(text);
      }
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.sessions.clear();
  }
}
