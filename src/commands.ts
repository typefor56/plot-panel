import * as os from 'node:os';
import * as vscode from 'vscode';
import type { DisplayOptions } from './displayOptions';
import type { PlotHistory } from './history';
import { extensionForMime } from './mime';
import type { PlotsViewProvider } from './plotsView';
import type { PlotEntry } from './types';

function defaultSaveUri(entry: PlotEntry): vscode.Uri {
  const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
  const stamp = new Date(entry.timestamp)
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  return vscode.Uri.joinPath(base, `plot_${stamp}.${extensionForMime(entry.mime)}`);
}

function saveFilters(entry: PlotEntry): Record<string, string[]> {
  const extension = extensionForMime(entry.mime);
  return { Image: [extension] };
}

async function savePlot(history: PlotHistory): Promise<void> {
  const entry = history.selected;
  if (entry === undefined) {
    void vscode.window.showInformationMessage('Plot Panel: no plot to save.');
    return;
  }
  const target = await vscode.window.showSaveDialog({
    defaultUri: defaultSaveUri(entry),
    filters: saveFilters(entry),
    saveLabel: 'Save Plot',
  });
  if (target === undefined) {
    return;
  }
  // Written byte-for-byte in the original format produced by the kernel.
  await vscode.workspace.fs.writeFile(target, entry.data);
}

async function exportAll(history: PlotHistory): Promise<void> {
  if (history.entries.length === 0) {
    void vscode.window.showInformationMessage('Plot Panel: the history is empty.');
    return;
  }
  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: 'Export Plots',
  });
  const folder = folders?.[0];
  if (folder === undefined) {
    return;
  }
  let count = 0;
  for (const entry of history.entries) {
    count += 1;
    const name = `plot_${String(count).padStart(3, '0')}.${extensionForMime(entry.mime)}`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(folder, name), entry.data);
  }
  void vscode.window.showInformationMessage(
    `Plot Panel: exported ${count} plot${count === 1 ? '' : 's'} to ${folder.fsPath}.`,
  );
}

export function registerCommands(
  context: vscode.ExtensionContext,
  history: PlotHistory,
  provider: PlotsViewProvider,
  display: DisplayOptions,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('plotPanel.previousPlot', () => history.previous()),
    vscode.commands.registerCommand('plotPanel.nextPlot', () => history.next()),
    vscode.commands.registerCommand('plotPanel.clearHistory', () => history.clear()),
    vscode.commands.registerCommand('plotPanel.savePlot', () => savePlot(history)),
    vscode.commands.registerCommand('plotPanel.copyPlot', () => provider.copySelected()),
    vscode.commands.registerCommand('plotPanel.exportAll', () => exportAll(history)),
    vscode.commands.registerCommand('plotPanel.zoomFit', () => display.setMode('fit')),
    vscode.commands.registerCommand('plotPanel.zoomFifty', () => display.setMode('zoom-50')),
    vscode.commands.registerCommand('plotPanel.zoomSeventyFive', () => display.setMode('zoom-75')),
    vscode.commands.registerCommand('plotPanel.zoomOneHundred', () => display.setMode('actual')),
    vscode.commands.registerCommand('plotPanel.zoomTwoHundred', () => display.setMode('zoom-200')),
    vscode.commands.registerCommand('plotPanel.sizeFillWidth', () => display.setMode('fill-width')),
    vscode.commands.registerCommand('plotPanel.sizeFillHeight', () =>
      display.setMode('fill-height'),
    ),
    vscode.commands.registerCommand('plotPanel.sizeActual', () => display.setMode('actual')),
    vscode.commands.registerCommand('plotPanel.toggleDarkFilter', () =>
      display.toggleDarkFilter(),
    ),
  );
}
