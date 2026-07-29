import * as assert from 'assert';
import * as vscode from 'vscode';

suite('Smoke', () => {
  test('extension is present and activates', async () => {
    const extension = vscode.extensions.getExtension('for56.plot-panel');
    assert.ok(extension, 'extension not found in the test host');
    await extension.activate();
    assert.strictEqual(extension.isActive, true);
  });

  test('all contributed commands are registered', async () => {
    const extension = vscode.extensions.getExtension('for56.plot-panel');
    assert.ok(extension);
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    for (const id of [
      'plotPanel.previousPlot',
      'plotPanel.nextPlot',
      'plotPanel.savePlot',
      'plotPanel.copyPlot',
      'plotPanel.exportAll',
      'plotPanel.clearHistory',
      'plotPanel.zoomFit',
      'plotPanel.zoomFifty',
      'plotPanel.zoomSeventyFive',
      'plotPanel.zoomOneHundred',
      'plotPanel.zoomTwoHundred',
      'plotPanel.sizeFillWidth',
      'plotPanel.sizeFillHeight',
      'plotPanel.sizeActual',
      'plotPanel.toggleDarkFilter',
      'plotPanel.openPlotInEditor',
      'plotPanel.openPlotBeside',
      'plotPanel.openPlotInNewWindow',
      'plotPanel.openGallery',
      'plotPanel.openGalleryInNewWindow',
      'plotPanel.copyPlotCode',
      'plotPanel.revealPlotCode',
      'plotPanel.rerunPlotCode',
      'plotPanel.refreshVariables',
    ]) {
      assert.ok(commands.includes(id), `command ${id} is not registered`);
    }
  });
});
