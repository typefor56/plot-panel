import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Smoke', () => {
  test('extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension('for56.plot-panel');
    assert.ok(extension, 'extension not found in the test host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });
});
