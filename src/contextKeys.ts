import * as vscode from 'vscode';
import type { PlotHistory } from './history';

/**
 * Custom `when`-clause context keys, centralized: this is the only module
 * allowed to call the setContext command.
 */
export class ContextKeys implements vscode.Disposable {
  private readonly unsubscribe: () => void;
  private lastHasCode: boolean | undefined;

  constructor(private readonly history: PlotHistory) {
    this.unsubscribe = history.onDidChange(() => this.update());
    this.update();
  }

  private update(): void {
    const hasCode = this.history.selected?.code !== undefined;
    if (hasCode !== this.lastHasCode) {
      this.lastHasCode = hasCode;
      void vscode.commands.executeCommand('setContext', 'plotPanel.selectedHasCode', hasCode);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
