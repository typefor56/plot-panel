import * as vscode from 'vscode';
import type { PlotEntry } from './types';

/**
 * Actions on the code that produced a plot, from the metadata captured with
 * each entry. Reveal and re-run are best effort by design: cells move,
 * notebooks close, files change — every failure ends in an explicit error
 * message, never a silent no-op.
 */

function noCode(): void {
  void vscode.window.showInformationMessage('Plot Panel: no code was recorded for this plot.');
}

/**
 * Locate the originating cell: exact source match first (robust against cells
 * moving around), captured index as fallback (robust against edits).
 */
function findCellIndex(notebook: vscode.NotebookDocument, entry: PlotEntry): number | undefined {
  const cells = notebook.getCells();
  const byText = cells.findIndex(
    (cell) =>
      cell.kind === vscode.NotebookCellKind.Code && cell.document.getText() === entry.code,
  );
  if (byText !== -1) {
    return byText;
  }
  if (entry.cellIndex !== undefined && entry.cellIndex >= 0 && entry.cellIndex < cells.length) {
    return entry.cellIndex;
  }
  return undefined;
}

export async function copyPlotCode(entry: PlotEntry | undefined): Promise<void> {
  if (entry?.code === undefined) {
    noCode();
    return;
  }
  await vscode.env.clipboard.writeText(entry.code);
  vscode.window.setStatusBarMessage('Plot code copied to clipboard', 3000);
}

export async function revealPlotCode(entry: PlotEntry | undefined): Promise<void> {
  if (entry?.code === undefined) {
    noCode();
    return;
  }
  // Interactive Window plots point back at the # %% block in the source file.
  if (entry.originUri !== undefined) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.originUri));
      const line = Math.min(Math.max(entry.originLine ?? 0, 0), document.lineCount - 1);
      await vscode.window.showTextDocument(document, {
        selection: new vscode.Range(line, 0, line, 0),
      });
      return;
    } catch {
      // Source file gone: fall through to the notebook document, then error.
    }
  }
  if (entry.notebookUri !== undefined) {
    try {
      const notebook = await vscode.workspace.openNotebookDocument(
        vscode.Uri.parse(entry.notebookUri),
      );
      const editor = await vscode.window.showNotebookDocument(notebook);
      const index = findCellIndex(notebook, entry);
      if (index !== undefined) {
        const range = new vscode.NotebookRange(index, index + 1);
        editor.revealRange(range, vscode.NotebookEditorRevealType.InCenter);
        editor.selection = range;
        return;
      }
    } catch {
      // Unopenable notebook (e.g. a closed Interactive Window): error below.
    }
  }
  void vscode.window.showErrorMessage(
    'Plot Panel: could not reveal the code — the originating document is gone.',
  );
}

export async function rerunPlotCode(entry: PlotEntry | undefined): Promise<void> {
  if (entry?.code === undefined) {
    noCode();
    return;
  }
  // Only re-run in a notebook that is still open: force-opening one would
  // not have a kernel attached anyway.
  const notebook = vscode.workspace.notebookDocuments.find(
    (candidate) => candidate.uri.toString() === entry.notebookUri,
  );
  if (notebook === undefined) {
    void vscode.window.showErrorMessage(
      'Plot Panel: the originating notebook is no longer open.',
    );
    return;
  }
  const index = findCellIndex(notebook, entry);
  if (index === undefined) {
    void vscode.window.showErrorMessage(
      'Plot Panel: the originating cell was not found in the notebook.',
    );
    return;
  }
  try {
    await vscode.commands.executeCommand('notebook.cell.execute', {
      ranges: [{ start: index, end: index + 1 }],
      document: notebook.uri,
    });
  } catch {
    void vscode.window.showErrorMessage('Plot Panel: running the cell failed.');
  }
}
