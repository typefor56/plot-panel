import * as vscode from 'vscode';
import type { DisplayOptions } from './displayOptions';
import type { PlotHistory } from './history';
import type { SessionRegistry } from './sessionRegistry';
import type { ThumbnailCache } from './thumbnails';
import type { PlotEntry } from './types';
import { PlotWebviewSession, reportCopyResult } from './webviewSession';

/**
 * Editor-tab surfaces for plots: a singleton gallery panel (full history with
 * the thumbnail strip) and any number of single-plot panels pinned to one
 * entry. Each panel webview is wrapped in a PlotWebviewSession, so the
 * protocol, re-hydration and CSP skeleton are exactly the sidebar's. Panels
 * do not retain context when hidden: the ready/state handshake re-hydrates
 * them, like the sidebar view.
 *
 * "New window" is the panel moved out through
 * workbench.action.moveEditorToNewWindow, which acts on the active editor —
 * panels are therefore created (or revealed) with focus first.
 */
export class PanelManager implements vscode.Disposable {
  static readonly galleryViewType = 'plotPanel.gallery';
  static readonly singleViewType = 'plotPanel.plot';

  private gallery: vscode.WebviewPanel | undefined;
  private readonly sessions = new Map<vscode.WebviewPanel, PlotWebviewSession>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly history: PlotHistory,
    private readonly thumbnails: ThumbnailCache,
    private readonly display: DisplayOptions,
    private readonly registry: SessionRegistry,
  ) {}

  /** Revive panels across window reloads (single panels carry their pin in webview state). */
  registerSerializers(): vscode.Disposable {
    const gallerydisposable = vscode.window.registerWebviewPanelSerializer(
      PanelManager.galleryViewType,
      {
        deserializeWebviewPanel: (panel: vscode.WebviewPanel): Thenable<void> => {
          this.adoptGallery(panel);
          return Promise.resolve();
        },
      },
    );
    const singleDisposable = vscode.window.registerWebviewPanelSerializer(
      PanelManager.singleViewType,
      {
        deserializeWebviewPanel: (panel: vscode.WebviewPanel, state: unknown): Thenable<void> => {
          const pinnedId =
            typeof state === 'object' &&
            state !== null &&
            'pinnedId' in state &&
            typeof (state as { pinnedId: unknown }).pinnedId === 'string'
              ? (state as { pinnedId: string }).pinnedId
              : undefined;
          this.adopt(panel, pinnedId === undefined ? { mode: 'single' } : { mode: 'single', pinnedId });
          return Promise.resolve();
        },
      },
    );
    return vscode.Disposable.from(gallerydisposable, singleDisposable);
  }

  openGallery(column: vscode.ViewColumn = vscode.ViewColumn.Active): void {
    if (this.gallery !== undefined) {
      this.gallery.reveal(column, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      PanelManager.galleryViewType,
      'Plots Gallery',
      column,
    );
    this.adoptGallery(panel);
  }

  async openGalleryInNewWindow(): Promise<void> {
    this.openGallery(vscode.ViewColumn.Active);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  openSingle(entry: PlotEntry, column: vscode.ViewColumn): void {
    const panel = vscode.window.createWebviewPanel(
      PanelManager.singleViewType,
      `Plot: ${entry.source}`,
      column,
    );
    this.adopt(panel, { mode: 'single', pinnedId: entry.id });
  }

  async openSingleInNewWindow(entry: PlotEntry): Promise<void> {
    this.openSingle(entry, vscode.ViewColumn.Active);
    await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow');
  }

  /**
   * The plot a toolbar command should act on when an editor panel is active:
   * the pinned entry of a single-plot panel, the history selection otherwise.
   */
  activePinnedEntry(): PlotEntry | undefined {
    for (const [panel, session] of this.sessions) {
      if (panel.active && session.mode === 'single' && session.pinnedId !== undefined) {
        return this.history.entries.find((entry) => entry.id === session.pinnedId);
      }
    }
    return undefined;
  }

  /**
   * Copy through the active panel's own (already visible) webview. Returns
   * false when no panel is active so the caller can fall back to the sidebar.
   */
  async copyFromActivePanel(): Promise<boolean> {
    const active = [...this.sessions.entries()].find(([panel]) => panel.active);
    if (active === undefined) {
      return false;
    }
    const [panel, session] = active;
    const entry =
      session.mode === 'single'
        ? this.history.entries.find((candidate) => candidate.id === session.pinnedId)
        : this.history.selected;
    if (entry === undefined) {
      void vscode.window.showInformationMessage('Plot Panel: no plot to copy.');
      return true;
    }
    panel.reveal(undefined, false);
    if (!(await session.whenReady(3000))) {
      void vscode.window.showErrorMessage('Plot Panel: the plot panel did not become ready.');
      return true;
    }
    reportCopyResult(await session.copy(entry));
    return true;
  }

  private adoptGallery(panel: vscode.WebviewPanel): void {
    this.gallery?.dispose();
    this.gallery = panel;
    panel.onDidDispose(() => {
      if (this.gallery === panel) {
        this.gallery = undefined;
      }
    });
    this.adopt(panel, { mode: 'gallery' });
  }

  private adopt(
    panel: vscode.WebviewPanel,
    options: { mode: 'gallery' | 'single'; pinnedId?: string },
  ): void {
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.svg');
    const session = new PlotWebviewSession(
      panel.webview,
      this.extensionUri,
      this.history,
      this.thumbnails,
      this.display,
      this.registry,
      options,
    );
    this.registry.add(session);
    this.sessions.set(panel, session);
    panel.onDidDispose(() => {
      session.dispose();
      this.sessions.delete(panel);
    });
  }

  dispose(): void {
    for (const panel of [...this.sessions.keys()]) {
      panel.dispose();
    }
    this.sessions.clear();
    this.gallery = undefined;
  }
}
