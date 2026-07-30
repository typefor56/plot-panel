import * as vscode from 'vscode';
import { contentId } from './hash';
import type { PlotHistory } from './history';
import { findWidgetMime, pickImageItem } from './mime';
import type { PlotEntry, PlotSourceKind } from './types';

/**
 * Automatic capture of image outputs from notebook documents.
 *
 * VS Code models the Interactive Window as a notebook document
 * (notebookType "interactive"), so a single onDidChangeNotebookDocument
 * subscription covers notebooks and the interactive console alike. We listen
 * to every notebook type rather than an allow-list: any kernel that emits
 * image outputs benefits, and the test host can drive capture with its own
 * notebook type.
 */

export type UnsupportedOutputListener = (mime: string, source: string) => void;

function sourceKindOf(notebook: vscode.NotebookDocument): PlotSourceKind {
  return notebook.notebookType === 'interactive' ? 'interactive' : 'notebook';
}

function sourceLabelOf(notebook: vscode.NotebookDocument): string {
  if (notebook.notebookType === 'interactive') {
    return 'Interactive Window';
  }
  if (notebook.uri.scheme === 'untitled') {
    return 'Untitled notebook';
  }
  const path = notebook.uri.path;
  const slash = path.lastIndexOf('/');
  return slash === -1 ? path : path.slice(slash + 1);
}

/** Cells larger than this keep a truncated code snapshot (bounds index.json). */
const CODE_CAP = 10_000;

interface InteractiveOrigin {
  readonly uristring: string;
  readonly lineIndex: number;
}

/**
 * The Jupyter extension stamps Interactive Window cells with untyped metadata
 * pointing back at the `# %%` block in the source file; narrow it structurally.
 */
function interactiveOriginOf(cell: vscode.NotebookCell): InteractiveOrigin | undefined {
  const raw: unknown = cell.metadata['interactive'];
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const record = raw as Record<string, unknown>;
  const uristring = record['uristring'];
  const lineIndex = record['lineIndex'];
  if (typeof uristring !== 'string' || typeof lineIndex !== 'number') {
    return undefined;
  }
  return { uristring, lineIndex };
}

export class PlotCapture implements vscode.Disposable {
  private readonly subscription: vscode.Disposable;
  private readonly unsupportedListeners = new Set<UnsupportedOutputListener>();

  constructor(
    private readonly history: PlotHistory,
    private readonly follow: () => boolean,
  ) {
    this.subscription = vscode.workspace.onDidChangeNotebookDocument((event) =>
      this.handleChange(event),
    );
  }

  /** Fired when an output only has interactive-widget representations (plotly, bokeh, ipywidgets…). */
  onUnsupportedOutput(listener: UnsupportedOutputListener): vscode.Disposable {
    this.unsupportedListeners.add(listener);
    return new vscode.Disposable(() => this.unsupportedListeners.delete(listener));
  }

  private handleChange(event: vscode.NotebookDocumentChangeEvent): void {
    for (const change of event.cellChanges) {
      // `outputs` is undefined when the change did not touch outputs.
      if (change.outputs === undefined) {
        continue;
      }
      for (const output of change.outputs) {
        this.ingest(output.items, event.notebook, change.cell);
      }
    }
  }

  private ingest(
    items: readonly vscode.NotebookCellOutputItem[],
    notebook: vscode.NotebookDocument,
    cell: vscode.NotebookCell,
  ): void {
    const image = pickImageItem(items);
    if (image !== undefined) {
      const sourceKind = sourceKindOf(notebook);
      const code = cell.document.getText().slice(0, CODE_CAP);
      const origin = sourceKind === 'interactive' ? interactiveOriginOf(cell) : undefined;
      const entry: PlotEntry = {
        id: contentId(image.mime, image.data),
        mime: image.mime,
        data: image.data,
        timestamp: Date.now(),
        source: sourceLabelOf(notebook),
        sourceKind,
        ...(code.length > 0 ? { code } : {}),
        notebookUri: notebook.uri.toString(),
        ...(cell.index >= 0 ? { cellIndex: cell.index } : {}),
        // Distinguishes several figures from ONE execution of a cell from the
        // same cell run again: both share a cell index, not an execution.
        ...(cell.executionSummary?.executionOrder !== undefined
          ? { executionOrder: cell.executionSummary.executionOrder }
          : {}),
        ...(origin !== undefined
          ? { originUri: origin.uristring, originLine: origin.lineIndex }
          : {}),
      };
      this.history.add(entry, this.follow());
      return;
    }
    const widgetMime = findWidgetMime(items);
    if (widgetMime !== undefined) {
      const source = sourceLabelOf(notebook);
      for (const listener of this.unsupportedListeners) {
        listener(widgetMime, source);
      }
    }
  }

  dispose(): void {
    this.subscription.dispose();
    this.unsupportedListeners.clear();
  }
}
