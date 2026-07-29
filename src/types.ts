/** Kind of notebook document a plot came from. */
export type PlotSourceKind = 'notebook' | 'interactive';

/** One captured figure. `id` is a SHA-256 hash of mime + bytes, used for deduplication. */
export interface PlotEntry {
  readonly id: string;
  readonly mime: string;
  readonly data: Uint8Array;
  readonly timestamp: number;
  /** Human-readable label of the originating document. */
  readonly source: string;
  readonly sourceKind: PlotSourceKind;
}
