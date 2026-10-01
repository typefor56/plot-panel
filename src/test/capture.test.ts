import * as assert from 'assert';
import * as vscode from 'vscode';
import type { PlotPanelApi } from '../extension';

/**
 * Drives real output capture in the extension host. A test NotebookController
 * is registered for the jupyter-notebook type (contributed by the bundled
 * vscode.ipynb extension) and cells are run through the actual notebook
 * execution pipeline, so outputs reach the extension exactly as they would
 * from a real Jupyter kernel.
 */

const NOTEBOOK_TYPE = 'jupyter-notebook';

// 1x1 red PNG.
const PNG_A = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
// 1x1 blue PNG (different bytes than PNG_A).
const PNG_B = Buffer.from(
  'iVBORw0KGgoAAAABAAABCAYAAAAfFcSJAAAADUlEQVR42mNgYPj/HwADAgH/p+FnhAAAAABJRU5ErkJggg==',
  'base64',
);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>', 'utf8');

let controller: vscode.NotebookController | undefined;
/** Output items the fake kernel will emit for the next executions, FIFO. */
const pendingOutputs: vscode.NotebookCellOutputItem[][] = [];

function ensureController(): void {
  if (controller !== undefined) {
    return;
  }
  controller = vscode.notebooks.createNotebookController(
    'plotpanel-test-kernel',
    NOTEBOOK_TYPE,
    'Plot Panel Test Kernel',
  );
  controller.supportedLanguages = ['python'];
  controller.executeHandler = async (cells, _notebook, ctrl) => {
    for (const cell of cells) {
      const execution = ctrl.createNotebookCellExecution(cell);
      execution.start(Date.now());
      const items = pendingOutputs.shift() ?? [];
      // Twice, like a real kernel re-firing output events within one
      // execution: every test also checks that those repeats collapse.
      await execution.replaceOutput(new vscode.NotebookCellOutput(items));
      await execution.replaceOutput(new vscode.NotebookCellOutput(items));
      execution.end(true, Date.now());
    }
  };
}

async function activateExtension(): Promise<PlotPanelApi> {
  const extension = vscode.extensions.getExtension<PlotPanelApi>('for56.plot-panel');
  assert.ok(extension, 'extension not found in the test host');
  const api = await extension.activate();
  // Wait for the persisted-history restore: it must not race with the tests'
  // own history manipulation.
  await api.ready;
  ensureController();
  return api;
}

async function openTestNotebook(): Promise<vscode.NotebookDocument> {
  const data = new vscode.NotebookData([
    new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'pass', 'python'),
  ]);
  const notebook = await vscode.workspace.openNotebookDocument(NOTEBOOK_TYPE, data);
  await vscode.window.showNotebookDocument(notebook);
  return notebook;
}

/** Run cell 0 through the real execution pipeline, emitting the given items. */
async function executeWithOutputs(
  notebook: vscode.NotebookDocument,
  items: vscode.NotebookCellOutputItem[],
): Promise<void> {
  pendingOutputs.push(items);
  assert.ok(controller, 'test controller missing');
  assert.strictEqual(
    vscode.window.activeNotebookEditor?.notebook,
    notebook,
    'test notebook must be the active editor',
  );
  await vscode.commands.executeCommand('notebook.execute');
  // The execute command resolves before the handler necessarily ran; wait for
  // the fake kernel to consume the queued output.
  await waitFor(() => pendingOutputs.length === 0, 'test kernel execution');
}

async function waitFor(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10000;
  while (!condition()) {
    if (Date.now() > deadline) {
      assert.fail(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

suite('capture in a real extension host', () => {
  test('an image output lands in the history without user action', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await openTestNotebook();
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await waitFor(() => api.history.entries.length === 1, 'captured plot');
    const entry = api.history.entries[0];
    assert.ok(entry);
    assert.strictEqual(entry.mime, 'image/png');
    assert.deepStrictEqual(Buffer.from(entry.data), PNG_A);
    assert.strictEqual(api.history.selected?.id, entry.id);
  });

  test('every execution re-adds its figure, even byte-identical', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await openTestNotebook();
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await waitFor(() => api.history.entries.length === 1, 'first capture');
    // Re-running the same code is a new run in the history: the strip reads
    // chronologically, not as a set of distinct images.
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_B, 'image/png')]);
    await waitFor(() => api.history.entries.length === 3, 'one entry per execution');
    const [first, second, third] = api.history.entries;
    assert.ok(first && second && third);
    assert.strictEqual(first.contentHash, second.contentHash);
    assert.notStrictEqual(first.id, second.id);
    assert.notStrictEqual(first.run, second.run);
    assert.notStrictEqual(second.contentHash, third.contentHash);
    assert.strictEqual(api.history.selected?.id, third.id);
  });

  test('a capture records the originating cell, its code and the notebook uri', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await openTestNotebook();
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await waitFor(() => api.history.entries.length === 1, 'captured plot');
    const entry = api.history.entries[0];
    assert.ok(entry);
    assert.strictEqual(entry.code, 'pass');
    assert.strictEqual(entry.cellIndex, 0);
    assert.strictEqual(entry.notebookUri, notebook.uri.toString());
    assert.strictEqual(entry.originUri, undefined, 'not an Interactive Window cell');
  });

  test('a byte-identical re-run records the code it actually ran', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await openTestNotebook();
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await waitFor(() => api.history.entries.length === 1, 'first capture');
    // Change the cell source, then emit the same bytes again: a new entry,
    // carrying the edited code.
    const cell = notebook.cellAt(0);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(
      cell.document.uri,
      new vscode.Range(0, 0, cell.document.lineCount, 0),
      'pass  # edited',
    );
    assert.ok(await vscode.workspace.applyEdit(edit), 'cell edit must apply');
    await executeWithOutputs(notebook, [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await waitFor(() => api.history.entries.length === 2, 'second run');
    assert.strictEqual(api.history.entries[0]?.code, 'pass');
    assert.strictEqual(api.history.entries[1]?.code, 'pass  # edited');
  });

  test('a Run All is one labelled run, a lone cell run another', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await vscode.workspace.openNotebookDocument(
      NOTEBOOK_TYPE,
      new vscode.NotebookData(
        [0, 1, 2].map(
          (i) => new vscode.NotebookCellData(vscode.NotebookCellKind.Code, `c${i}`, 'python'),
        ),
      ),
    );
    await vscode.window.showNotebookDocument(notebook);
    // Cell 1 draws nothing: it still belongs to the Run All.
    pendingOutputs.push(
      [new vscode.NotebookCellOutputItem(PNG_A, 'image/png')],
      [],
      [new vscode.NotebookCellOutputItem(PNG_B, 'image/png')],
    );
    await vscode.commands.executeCommand('notebook.execute');
    await waitFor(() => api.history.entries.length === 2, 'Run All figures');
    const [a, b] = api.history.entries;
    assert.ok(a?.run !== undefined && a.run === b?.run, 'one run for the whole Run All');
    assert.match(api.history.runLabel(a.run) ?? '', /^Run all \d+$/);

    await new Promise((resolve) => setTimeout(resolve, 1500)); // a human pause
    pendingOutputs.push([new vscode.NotebookCellOutputItem(PNG_A, 'image/png')]);
    await vscode.commands.executeCommand(
      'notebook.cell.execute',
      { ranges: [{ start: 1, end: 2 }] },
      notebook.uri,
    );
    await waitFor(() => api.history.entries.length === 3, 'lone cell run');
    const lone = api.history.entries[2];
    assert.ok(lone?.run !== undefined && lone.run !== a.run);
    assert.match(api.history.runLabel(lone.run) ?? '', /^Run( \d+)?$/);
  });

  test('the richest MIME representation wins (SVG over PNG)', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notebook = await openTestNotebook();
    await executeWithOutputs(notebook, [
      new vscode.NotebookCellOutputItem(PNG_A, 'image/png'),
      new vscode.NotebookCellOutputItem(SVG, 'image/svg+xml'),
    ]);
    await waitFor(() => api.history.entries.length === 1, 'captured plot');
    assert.strictEqual(api.history.entries[0]?.mime, 'image/svg+xml');
  });

  test('widget-only outputs raise an explicit notice instead of a silent no-op', async () => {
    const api = await activateExtension();
    api.history.clear();
    const notices: string[] = [];
    const subscription = api.capture.onUnsupportedOutput((mime) => notices.push(mime));
    try {
      const notebook = await openTestNotebook();
      await executeWithOutputs(notebook, [
        new vscode.NotebookCellOutputItem(
          Buffer.from('{}', 'utf8'),
          'application/vnd.plotly.v1+json',
        ),
      ]);
      await waitFor(() => notices.length > 0, 'unsupported-output notice');
      assert.strictEqual(notices[0], 'application/vnd.plotly.v1+json');
      assert.strictEqual(api.history.entries.length, 0);
    } finally {
      subscription.dispose();
    }
  });
});
