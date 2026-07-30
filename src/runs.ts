/**
 * Grouping the plot history into the runs that produced it.
 *
 * A long session is a wall of thumbnails; what the eye looks for is "the
 * figures from that run". VS Code exposes no notion of a run on the stable
 * API — there is no event for "the user pressed Run All" — so the boundaries
 * are inferred from what each capture already records.
 *
 * The signal that works is the cell index: a run walks the notebook downwards,
 * so a capture from a cell at or above the previous one means the user started
 * again. Captures with no cell metadata (restored from an older store, or from
 * the Interactive Window) fall back to a gap in time.
 *
 * Pure module, no vscode import.
 */

export interface RunGroup {
  /** 1-based, in capture order. */
  readonly run: number;
  /** Index of the first entry of the run in the history. */
  readonly startIndex: number;
  readonly count: number;
}

/** What grouping needs of a plot; PlotEntry satisfies it. */
export interface Runnable {
  readonly timestamp: number;
  readonly notebookUri?: string | undefined;
  readonly cellIndex?: number | undefined;
  /** Execution count of the cell, telling one run of it from the next. */
  readonly executionOrder?: number | undefined;
}

/** Silence long enough to read as a separate run, for entries without a cell. */
const GAP_MS = 60_000;

function startsRun(entry: Runnable, previous: Runnable): boolean {
  if (entry.notebookUri !== previous.notebookUri) {
    return true;
  }
  if (entry.cellIndex !== undefined && previous.cellIndex !== undefined) {
    if (entry.cellIndex < previous.cellIndex) {
      return true; // back up the notebook: the user started again
    }
    if (entry.cellIndex > previous.cellIndex) {
      return false; // still walking down the same run
    }
    // Same cell: one execution of it can draw many figures, and those belong
    // together. Only a *different* execution of that cell is a new run.
    return (
      entry.executionOrder === undefined ||
      previous.executionOrder === undefined ||
      entry.executionOrder !== previous.executionOrder
    );
  }
  return entry.timestamp - previous.timestamp > GAP_MS;
}

/**
 * Whether cells finishing at these indices begin a new run, given the
 * furthest cell the current run has reached.
 *
 * Same rule as the plot strip, for the same reason: a run walks the notebook
 * downwards, so a cell at or above the one already reached means the user
 * started again. Time is deliberately not used — a Run All whose cell takes
 * a minute is still one run.
 */
export function startsNewRun(
  finishedIndices: readonly number[],
  reached: number | undefined,
): boolean {
  if (reached === undefined || finishedIndices.length === 0) {
    return true;
  }
  return Math.min(...finishedIndices) <= reached;
}

/**
 * Consecutive runs covering the history, oldest first. Always covers every
 * entry: concatenating the groups reproduces the input length.
 */
export function groupIntoRuns(entries: readonly Runnable[]): readonly RunGroup[] {
  const groups: RunGroup[] = [];
  entries.forEach((entry, index) => {
    const previous = entries[index - 1];
    if (previous === undefined || startsRun(entry, previous)) {
      groups.push({ run: groups.length + 1, startIndex: index, count: 1 });
      return;
    }
    const current = groups[groups.length - 1];
    if (current !== undefined) {
      groups[groups.length - 1] = { ...current, count: current.count + 1 };
    }
  });
  return groups;
}
