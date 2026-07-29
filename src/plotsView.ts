import * as vscode from 'vscode';
import type { PlotHistory } from './history';
import type { SessionRegistry } from './sessionRegistry';
import type { ThumbnailCache } from './thumbnails';
import { PlotWebviewSession, reportCopyResult } from './webviewSession';

/**
 * The Plots sidebar view: a thin WebviewViewProvider that attaches a shared
 * PlotWebviewSession (gallery mode) to the view's webview on every resolve.
 * All protocol and rendering logic lives in the session.
 */
export class PlotsViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewType = 'plotPanel.plots';

  private view: vscode.WebviewView | undefined;
  private session: PlotWebviewSession | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: PlotHistory,
    private readonly thumbnails: ThumbnailCache,
    private readonly registry: SessionRegistry,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.session?.dispose();
    this.view = view;
    const session = new PlotWebviewSession(
      view.webview,
      this.extensionUri,
      this.history,
      this.thumbnails,
      this.registry,
      { mode: 'gallery' },
    );
    this.registry.add(session);
    this.session = session;
    view.onDidDispose(() => {
      session.dispose();
      if (this.view === view) {
        this.view = undefined;
        this.session = undefined;
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

  /**
   * Copy the selected figure to the clipboard as PNG through this view's
   * session. The view is focused first because the browser clipboard requires
   * a focused document.
   */
  async copySelected(): Promise<void> {
    const entry = this.history.selected;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('Plot Panel: no plot to copy.');
      return;
    }
    if (this.view === undefined) {
      await vscode.commands.executeCommand(`${PlotsViewProvider.viewType}.focus`);
    } else {
      this.view.show(false);
    }
    const session = await this.waitForSession();
    if (session === undefined || !(await session.whenReady(3000))) {
      void vscode.window.showErrorMessage('Plot Panel: the Plots view did not become ready.');
      return;
    }
    reportCopyResult(await session.copy(entry));
  }

  /** The focus command resolves the view asynchronously; wait for the session. */
  private async waitForSession(): Promise<PlotWebviewSession | undefined> {
    const deadline = Date.now() + 3000;
    while (this.session === undefined) {
      if (Date.now() > deadline) {
        return undefined;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return this.session;
  }

  dispose(): void {
    this.session?.dispose();
    this.session = undefined;
    this.view = undefined;
  }
}
