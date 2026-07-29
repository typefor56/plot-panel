import type * as vscode from 'vscode';

/**
 * How the current figure is rendered in every plot webview.
 *
 * Zoom presets and sizing policies are mutually exclusive states of one flat
 * enum: the last selection wins, which is the whole precedence rule. '100%'
 * and 'Actual size' are the same value on purpose. The state lives host-side
 * (webviews are stateless projections) and persists in globalState because it
 * is a toolbar toggle, not a preference worth a settings entry.
 */
export type DisplayMode =
  | 'fit'
  | 'fill-width'
  | 'fill-height'
  | 'actual'
  | 'zoom-50'
  | 'zoom-75'
  | 'zoom-200';

const MODE_KEY = 'plotPanel.displayMode';
const DARK_FILTER_KEY = 'plotPanel.darkFilter';

const MODES: readonly DisplayMode[] = [
  'fit',
  'fill-width',
  'fill-height',
  'actual',
  'zoom-50',
  'zoom-75',
  'zoom-200',
];

function isDisplayMode(value: unknown): value is DisplayMode {
  return typeof value === 'string' && (MODES as readonly string[]).includes(value);
}

export class DisplayOptions {
  private currentMode: DisplayMode;
  private dark: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(private readonly memento: vscode.Memento) {
    const stored: unknown = memento.get(MODE_KEY);
    this.currentMode = isDisplayMode(stored) ? stored : 'fit';
    this.dark = memento.get(DARK_FILTER_KEY) === true;
  }

  get mode(): DisplayMode {
    return this.currentMode;
  }

  setMode(mode: DisplayMode): void {
    if (mode === this.currentMode) {
      return;
    }
    this.currentMode = mode;
    void this.memento.update(MODE_KEY, mode);
    this.emit();
  }

  get darkFilter(): boolean {
    return this.dark;
  }

  toggleDarkFilter(): void {
    this.dark = !this.dark;
    void this.memento.update(DARK_FILTER_KEY, this.dark);
    this.emit();
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
