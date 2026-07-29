import * as os from 'node:os';
import * as vscode from 'vscode';
import type { PlotHistory } from './history';
import { extensionForMime } from './mime';
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

export function registerCommands(
  context: vscode.ExtensionContext,
  history: PlotHistory,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('plotPanel.previousPlot', () => history.previous()),
    vscode.commands.registerCommand('plotPanel.nextPlot', () => history.next()),
    vscode.commands.registerCommand('plotPanel.clearHistory', () => history.clear()),
    vscode.commands.registerCommand('plotPanel.savePlot', () => savePlot(history)),
  );
}
