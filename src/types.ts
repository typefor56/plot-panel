/** Kind of notebook document a plot came from. */
export type PlotSourceKind = 'notebook' | 'interactive';

/**
 * One captured figure. `id` identifies one capture — this content, from this
 * cell, in this run — so the output events VS Code repeats within a single
 * execution collapse, while running the cell again adds a new entry even when
 * the figure did not change. `contentHash` (SHA-256 of mime + bytes) names the
 * image on disk, where identical figures are stored once.
 */
export interface PlotEntry {
  readonly id: string;
  readonly contentHash: string;
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
  /** Execution count of that cell, identifying one run of it. */
  readonly executionOrder?: number;
  /** Execution batch (see runs.ts) the figure was drawn in. */
  readonly run?: number;
  /** Interactive Window only: the .py file the code was sent from. */
  readonly originUri?: string;
  /** Interactive Window only: 0-based line of the code in `originUri`. */
  readonly originLine?: number;
}
