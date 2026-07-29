/** Kind of notebook document a plot came from. */
export type PlotSourceKind = 'notebook' | 'interactive';

/**
 * One captured figure. `id` is a SHA-256 hash of mime + bytes, used for
 * deduplication — the optional origin metadata below does not participate in
 * it, so byte-identical output from another cell keeps the first capture's
 * metadata.
 */
export interface PlotEntry {
  readonly id: string;
  readonly mime: string;
  readonly data: Uint8Array;
  readonly timestamp: number;
  /** Human-readable label of the originating document. */
  readonly source: string;
  readonly sourceKind: PlotSourceKind;
  /** Source of the cell that produced the figure, capped at capture time. */
  readonly code?: string;
  /** URI of the originating notebook document. */
  readonly notebookUri?: string;
  /** Index of the originating cell at capture time (cells may move since). */
  readonly cellIndex?: number;
  /** Interactive Window only: the .py file the code was sent from. */
  readonly originUri?: string;
  /** Interactive Window only: 0-based line of the code in `originUri`. */
  readonly originLine?: number;
}
