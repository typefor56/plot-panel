import * as vscode from 'vscode';
import { PlotCapture } from './capture';
import { registerCommands } from './commands';
import { PlotHistory } from './history';
import { PlotStore } from './persistence';
import { PlotsViewProvider } from './plotsView';

/** Public surface returned by activate(), used by the extension-host tests. */
export interface PlotPanelApi {
  readonly history: PlotHistory;
  readonly capture: PlotCapture;
}

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('plotPanel');
}

export function activate(context: vscode.ExtensionContext): PlotPanelApi {
  const history = new PlotHistory(configuration().get('historyLimit', 50));
  const capture = new PlotCapture(history, () => configuration().get('followLatest', true));
  const provider = new PlotsViewProvider(context.extensionUri, history);
  const store = new PlotStore(vscode.Uri.joinPath(context.globalStorageUri, 'plots'));

  context.subscriptions.push(
    capture,
    provider,
    vscode.window.registerWebviewViewProvider(PlotsViewProvider.viewType, provider),
    capture.onUnsupportedOutput((mime, source) => {
      provider.showNotice(
        `Interactive output from ${source} (${mime}) has no static image to capture.`,
      );
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration('plotPanel.historyLimit')) {
        history.setLimit(configuration().get('historyLimit', 50));
      }
    }),
  );

  // Restore the persisted history, then keep the store in sync. autoReveal is
  // only hooked up afterwards so restoring plots never pops the view open on
  // startup — only genuinely new figures do.
  void (async () => {
    const snapshot = await store.load();
    for (const entry of snapshot.entries) {
      history.add(entry, false);
    }
    history.select(snapshot.selectedId ?? history.entries.at(-1)?.id);
    context.subscriptions.push(
      store.attach(history),
      new vscode.Disposable(
        history.onDidChange((event) => {
          if (event.type === 'added' && configuration().get('autoReveal', true)) {
            void provider.reveal();
          }
        }),
      ),
    );
  })();

  registerCommands(context, history);

  return { history, capture };
}

export function deactivate(): void {}
