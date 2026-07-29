import type { PlotEntry } from './types';

/**
 * Session history of captured plots.
 *
 * Pure model, no vscode dependency: deduplication by content id, FIFO
 * eviction when the configured limit is exceeded, and selection semantics.
 * The view and commands layer subscribe through onDidChange.
 */

export type HistoryEvent =
  | { readonly type: 'added'; readonly entry: PlotEntry }
  | { readonly type: 'evicted'; readonly ids: readonly string[] }
  | { readonly type: 'selected'; readonly id: string | undefined }
  | { readonly type: 'cleared' };

export type AddResult = 'added' | 'duplicate';

export class PlotHistory {
  private items: PlotEntry[] = [];
  private readonly byId = new Map<string, PlotEntry>();
  private currentId: string | undefined;
  private maxEntries: number;
  private readonly listeners = new Set<(event: HistoryEvent) => void>();

  constructor(limit: number) {
    this.maxEntries = PlotHistory.normalizeLimit(limit);
  }

  private static normalizeLimit(limit: number): number {
    return Math.max(1, Math.floor(limit));
  }

  get entries(): readonly PlotEntry[] {
    return this.items;
  }

  get limit(): number {
    return this.maxEntries;
  }

  get selected(): PlotEntry | undefined {
    return this.currentId === undefined ? undefined : this.byId.get(this.currentId);
  }

  get selectedIndex(): number {
    return this.currentId === undefined
      ? -1
      : this.items.findIndex((entry) => entry.id === this.currentId);
  }

  /** Subscribe to changes; returns an unsubscribe function. */
  onDidChange(listener: (event: HistoryEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: HistoryEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Add an entry. Content already present (same id) is a duplicate: nothing is
   * stored, but with `follow` the selection jumps to the existing entry so the
   * user still "sees the figure arrive".
   */
  add(entry: PlotEntry, follow: boolean): AddResult {
    if (this.byId.has(entry.id)) {
      if (follow) {
        this.select(entry.id);
      }
      return 'duplicate';
    }
    this.items.push(entry);
    this.byId.set(entry.id, entry);
    this.emit({ type: 'added', entry });
    this.evictOverLimit();
    if (follow || this.currentId === undefined) {
      this.select(entry.id);
    }
    return 'added';
  }

  /** Select by id. Unknown ids are ignored; `undefined` clears the selection. */
  select(id: string | undefined): void {
    if (id !== undefined && !this.byId.has(id)) {
      return;
    }
    if (id === this.currentId) {
      return;
    }
    this.currentId = id;
    this.emit({ type: 'selected', id });
  }

  selectIndex(index: number): void {
    const entry = this.items[index];
    if (entry !== undefined) {
      this.select(entry.id);
    }
  }

  /** Move selection toward the newest entry. */
  next(): void {
    const index = this.selectedIndex;
    this.selectIndex(index === -1 ? this.items.length - 1 : index + 1);
  }

  /** Move selection toward the oldest entry. */
  previous(): void {
    const index = this.selectedIndex;
    this.selectIndex(index === -1 ? 0 : index - 1);
  }

  setLimit(limit: number): void {
    this.maxEntries = PlotHistory.normalizeLimit(limit);
    this.evictOverLimit();
  }

  clear(): void {
    if (this.items.length === 0) {
      return;
    }
    this.items = [];
    this.byId.clear();
    this.currentId = undefined;
    this.emit({ type: 'cleared' });
  }

  private evictOverLimit(): void {
    if (this.items.length <= this.maxEntries) {
      return;
    }
    const evicted = this.items.splice(0, this.items.length - this.maxEntries);
    const ids = evicted.map((entry) => entry.id);
    for (const id of ids) {
      this.byId.delete(id);
    }
    this.emit({ type: 'evicted', ids });
    // If the selected entry was evicted, fall back to the oldest survivor.
    if (this.currentId !== undefined && !this.byId.has(this.currentId)) {
      const oldest = this.items[0];
      this.select(oldest?.id);
    }
  }
}
