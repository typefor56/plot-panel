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
  /** Execution batch recorded at capture; decides grouping when present. */
  readonly run?: number | undefined;
  readonly notebookUri?: string | undefined;
  readonly cellIndex?: number | undefined;
  /** Execution count of the cell, telling one run of it from the next. */
  readonly executionOrder?: number | undefined;
}

/** Silence long enough to read as a separate run, for entries without a cell. */
const GAP_MS = 60_000;

function startsRun(entry: Runnable, previous: Runnable): boolean {
  if (entry.run !== undefined && previous.run !== undefined) {
    return entry.run !== previous.run;
  }
  // Entries restored from a store older than execution batches: infer.
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

/**
 * Executions starting within this delay of the notebook's previous activity
 * belong to the same batch. Measured in a real extension host: Run All queues
 * every cell within a few milliseconds, and a kernel that only creates the
 * next execution when the previous one ends does so within ~10 ms; a person
 * re-running a cell by hand is far slower.
 */
// ponytail: fixed delay; a Shift+Enter quicker than this counts as one batch.
export const QUEUE_GAP_MS = 500;

interface NotebookRuns {
  /** Cells whose current execution is registered and has not ended. */
  readonly pending: Set<number>;
  /** executionOrder of each cell's last ended execution. */
  readonly ended: Map<number, number | undefined>;
  /** Batch each cell's latest execution belongs to. */
  readonly runOfCell: Map<number, number>;
  lastActivity: number;
  batch: Batch | undefined;
}

interface Batch {
  readonly run: number;
  readonly cells: Set<number>;
  executions: number;
  /** The count of the lone execution, naming it "Run N". */
  executionOrder: number | undefined;
  hasFigure: boolean;
  runAll: number | undefined;
}

/**
 * Splits a notebook's executions into batches — one Run All, or one cell run
 * on its own — and names them: "Run all 3" for the third multi-cell batch
 * that drew something, "Run 12" for a lone execution, 12 being the cell's
 * execution count as the notebook shows it in the gutter.
 *
 * Fed with every cell change carrying an execution summary (sequence
 * observed in a real extension host): VS Code sends a summary with neither
 * count nor timing for each cell as it is *queued* — a Run All queues all its
 * cells at once — then one with the count as it starts, then one with timing
 * as it ends. Pure, no vscode import.
 */
export class RunTracker {
  private readonly notebooks = new Map<string, NotebookRuns>();
  private nextRun = 1;
  private runAlls = 0;

  constructor(private readonly setLabel: (run: number, label: string) => void) {}

  /** Continue numbering after a restored history. */
  resume(lastRun: number, lastRunAll: number): void {
    this.nextRun = Math.max(this.nextRun, lastRun + 1);
    this.runAlls = Math.max(this.runAlls, lastRunAll);
  }

  observe(
    notebook: string,
    cellIndex: number,
    executionOrder: number | undefined,
    ended: boolean,
    now: number,
  ): void {
    const state = this.stateOf(notebook);
    if (ended) {
      state.pending.delete(cellIndex);
      state.ended.set(cellIndex, executionOrder);
      state.lastActivity = now;
      return;
    }
    const queued = executionOrder === undefined;
    // A summary without count on a cell already pending is that execution
    // starting — unless it was left pending by an older batch, or the notebook
    // sat idle since: then it was cancelled before it ran, and this is a fresh
    // queue.
    const batch = state.batch;
    if (
      state.pending.has(cellIndex) &&
      state.runOfCell.get(cellIndex) === batch?.run &&
      (!queued || now - state.lastActivity <= QUEUE_GAP_MS)
    ) {
      // A lone run is named after its count.
      if (
        !queued &&
        batch !== undefined &&
        batch.executions === 1 &&
        state.runOfCell.get(cellIndex) === batch.run
      ) {
        batch.executionOrder = executionOrder;
        this.label(batch);
      }
      return;
    }
    if (!queued && state.ended.get(cellIndex) === executionOrder) {
      return; // late echo of an execution that already ended
    }
    state.pending.add(cellIndex);
    // A Run All runs each cell once: the same cell again is a new batch.
    if (
      batch !== undefined &&
      !batch.cells.has(cellIndex) &&
      now - state.lastActivity <= QUEUE_GAP_MS
    ) {
      batch.cells.add(cellIndex);
      batch.executions++;
      this.label(batch);
      state.runOfCell.set(cellIndex, batch.run);
    } else {
      const fresh: Batch = {
        run: this.nextRun++,
        cells: new Set([cellIndex]),
        executions: 1,
        executionOrder,
        hasFigure: false,
        runAll: undefined,
      };
      state.batch = fresh;
      state.runOfCell.set(cellIndex, fresh.run);
      this.label(fresh);
    }
    state.lastActivity = now;
  }

  /**
   * Batch of the cell's latest execution, for a figure it just drew;
   * registers an execution when the kernel sent no summary at all.
   */
  runOf(notebook: string, cellIndex: number, executionOrder: number | undefined, now: number): number {
    const state = this.stateOf(notebook);
    if (!state.runOfCell.has(cellIndex)) {
      this.observe(notebook, cellIndex, executionOrder, false, now);
    }
    const run = state.runOfCell.get(cellIndex) ?? 0;
    const batch = state.batch;
    if (batch !== undefined && batch.run === run && !batch.hasFigure) {
      batch.hasFigure = true;
      this.label(batch);
    }
    return run;
  }

  forget(notebook: string): void {
    this.notebooks.delete(notebook);
  }

  private stateOf(notebook: string): NotebookRuns {
    let state = this.notebooks.get(notebook);
    if (state === undefined) {
      state = {
        pending: new Set(),
        ended: new Map(),
        runOfCell: new Map(),
        lastActivity: -Infinity,
        batch: undefined,
      };
      this.notebooks.set(notebook, state);
    }
    return state;
  }

  /**
   * A Run All only takes a number once it drew a figure: batches that never
   * reach the strip (clearing outputs also queues every cell) must not leave
   * gaps in the numbering the user reads.
   */
  private label(batch: Batch): void {
    if (batch.executions < 2) {
      this.setLabel(
        batch.run,
        batch.executionOrder === undefined ? 'Run' : `Run ${batch.executionOrder}`,
      );
      return;
    }
    if (batch.runAll === undefined && batch.hasFigure) {
      batch.runAll = ++this.runAlls;
    }
    this.setLabel(batch.run, batch.runAll === undefined ? 'Run all' : `Run all ${batch.runAll}`);
  }
}

/** Ordinal of a "Run all N" label, 0 for any other label. */
export function runAllOrdinal(label: string): number {
  const match = /^Run all (\d+)$/.exec(label);
  return match?.[1] === undefined ? 0 : Number(match[1]);
}
