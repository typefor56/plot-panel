import * as vscode from 'vscode';
import { PlotCapture } from './capture';
import { registerCommands } from './commands';
import { ContextKeys } from './contextKeys';
import { DisplayOptions } from './displayOptions';
import { PanelManager } from './galleryPanel';
import { PlotHistory } from './history';
import { PlotStore } from './persistence';
import { PlotsViewProvider } from './plotsView';
import { SessionRegistry } from './sessionRegistry';
import { ThumbnailCache } from './thumbnails';
import { JupyterVariablesSource } from './variables/jupyterApi';
import { VariablesOptions } from './variables/variablesOptions';
import { VariablesViewProvider } from './variables/variablesView';

/** Public surface returned by activate(), used by the extension-host tests. */
export interface PlotPanelApi {
  readonly history: PlotHistory;
  readonly capture: PlotCapture;
  readonly display: DisplayOptions;
  readonly variablesOptions: VariablesOptions;
  /** Refresh the Variables view now; resolves when the fetch completed. */
  readonly refreshVariables: () => Promise<void>;
  /** Resolves once the persisted history has been restored and the store attached. */
  readonly ready: Promise<void>;
}

function configuration(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('plotPanel');
}

export function activate(context: vscode.ExtensionContext): PlotPanelApi {
  const history = new PlotHistory(configuration().get('historyLimit', 50));
  const capture = new PlotCapture(history, () => configuration().get('followLatest', true));
  const thumbnails = new ThumbnailCache();
  const display = new DisplayOptions(context.globalState);
  const registry = new SessionRegistry(history);
  const provider = new PlotsViewProvider(
    context.extensionUri,
    history,
    thumbnails,
    display,
    registry,
  );
  const store = new PlotStore(vscode.Uri.joinPath(context.globalStorageUri, 'plots'));
  const panels = new PanelManager(context.extensionUri, history, thumbnails, display, registry);
  // The Jupyter Kernels API is publisher-gated: probing it on stable would
  // only earn a denial toast, so expansion is attempted where access is
  // possible (test host, Insiders) and the view hides its chevrons elsewhere.
  const variablesSource = new JupyterVariablesSource(
    context.extensionMode === vscode.ExtensionMode.Test ||
      vscode.env.appName.includes('Insiders'),
  );
  const variablesOptions = new VariablesOptions(context.globalState);
  const variables = new VariablesViewProvider(
    context.extensionUri,
    variablesSource,
    variablesOptions,
  );

  context.subscriptions.push(
    capture,
    registry,
    provider,
    panels,
    panels.registerSerializers(),
    new ContextKeys(history),
    variables,
    vscode.window.registerWebviewViewProvider(VariablesViewProvider.viewType, variables),
    vscode.commands.registerCommand('plotPanel.refreshVariables', () => variables.refresh()),
    vscode.commands.registerCommand('plotPanel.variablesGroupByKind', () =>
      variablesOptions.setGrouping('kind'),
    ),
    vscode.commands.registerCommand('plotPanel.variablesGroupBySize', () =>
      variablesOptions.setGrouping('size'),
    ),
    vscode.commands.registerCommand('plotPanel.variablesSortByName', () =>
      variablesOptions.setSorting('name'),
    ),
    vscode.commands.registerCommand('plotPanel.variablesSortBySize', () =>
      variablesOptions.setSorting('size'),
    ),
    vscode.commands.registerCommand('plotPanel.variablesSortByRecent', () =>
      variablesOptions.setSorting('recent'),
    ),
    vscode.window.registerWebviewViewProvider(PlotsViewProvider.viewType, provider),
    capture.onUnsupportedOutput((mime, source) => {
      registry.broadcastNotice(
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
  const ready = (async () => {
    const snapshot = await store.load();
    for (const [id, thumb] of snapshot.thumbnails) {
      thumbnails.set(id, thumb);
    }
    for (const entry of snapshot.entries) {
      history.add(entry, false);
    }
    history.select(snapshot.selectedId ?? history.entries.at(-1)?.id);
    thumbnails.prune(new Set(history.entries.map((entry) => entry.id)));
    context.subscriptions.push(
      store.attach(history, thumbnails),
      new vscode.Disposable(
        history.onDidChange((event) => {
          if (event.type === 'evicted' || event.type === 'cleared') {
            thumbnails.prune(new Set(history.entries.map((entry) => entry.id)));
          }
        }),
      ),
      new vscode.Disposable(
        history.onDidChange((event) => {
          if (event.type === 'added' && configuration().get('autoReveal', true)) {
            void provider.reveal();
          }
        }),
      ),
    );
  })().catch(() => {
    // load() and attach() are already defensive; never fail activation.
  });

  registerCommands(context, history, provider, display, panels);

  return {
    history,
    capture,
    display,
    variablesOptions,
    refreshVariables: () => variables.refresh(),
    ready,
  };
}

export function deactivate(): void {}
