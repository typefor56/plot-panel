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
 * Cells queued further apart than this are separate batches even when nothing
 * ran in between. Only a backstop: what really ends a queue burst is an
 * execution starting or ending. It has to be generous — a loaded VS Code was
 * seen spreading the queue events of ONE Run All over seconds, with holes of
 * more than 500 ms that cut it into six runs.
 */
// ponytail: fixed delay; cells queued by hand quicker than this while the
// kernel is busy with another cell count as one batch.
export const QUEUE_GAP_MS = 5000;

interface NotebookRuns {
  /**
   * The last two bursts each cell appeared in since its execution last ended,
   * oldest first.
   */
  readonly seen: Map<number, readonly Batch[]>;
  /** Cells whose current execution has been given its batch. */
  readonly running: Set<number>;
  /** executionOrder of each cell's last ended execution. */
  readonly ended: Map<number, number | undefined>;
  /** Batch each cell's latest execution belongs to. */
  readonly batchOfCell: Map<number, Batch>;
  lastBurst: number;
  burst: Batch | undefined;
}

interface Batch {
  /** Numbered once an execution really belongs to it. */
  run: number | undefined;
  readonly cells: Set<number>;
  /** An execution started or ended since: whatever is queued next is new. */
  closed: boolean;
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
 * Fed with every cell change carrying an execution summary. Sequence recorded
 * in a real extension host, with executions driven the way Jupyter drives
 * them: VS Code sends a summary with neither count nor timing for each cell
 * as it is *queued* — a Run All queues all its cells at once — then ANOTHER
 * one as the cell *starts*, then one with the count, then one with timing as
 * it ends. Clearing outputs and cancelling a queued cell also send a
 * count-less summary.
 *
 * Jupyter only starts a cell once the kernel acknowledges it, so a start can
 * trail the previous cell's end by seconds (a busy kernel, a cold one): no
 * delay tells a start from a fresh queue. Position does: an execution's queue
 * event is the count-less summary just before its start. Count-less
 * summaries are therefore only grouped into bursts, and an execution takes
 * the burst of the second to last one it received. A burst lasts until an
 * execution starts or ends, not for a set time: the clock of a loaded window
 * is no better at delimiting a queue than at delimiting a start. Pure, no
 * vscode import.
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
      state.seen.delete(cellIndex);
      // Not the late repeats of an end: those land anywhere.
      if (state.running.delete(cellIndex) && state.burst !== undefined) {
        state.burst.closed = true;
      }
      state.ended.set(cellIndex, executionOrder);
      return;
    }
    if (executionOrder === undefined) {
      this.burst(state, cellIndex, now);
      return;
    }
    // The count again — unless the cell was queued and started anew since,
    // its previous execution having lost its end to a kernel restart.
    if (state.running.has(cellIndex) && (state.seen.get(cellIndex)?.length ?? 0) < 2) {
      return;
    }
    if (!state.seen.has(cellIndex) && state.ended.get(cellIndex) === executionOrder) {
      return; // late echo of an execution that already ended
    }
    this.assign(state, cellIndex, executionOrder, now);
  }

  /**
   * Batch of the cell's latest execution, for a figure it just drew; a kernel
   * that never sends the count gets its batch here.
   */
  runOf(notebook: string, cellIndex: number, executionOrder: number | undefined, now: number): number {
    const state = this.stateOf(notebook);
    let batch = state.batchOfCell.get(cellIndex);
    if (batch === undefined || (!state.running.has(cellIndex) && state.seen.has(cellIndex))) {
      batch = this.assign(state, cellIndex, executionOrder, now);
    }
    if (!batch.hasFigure) {
      batch.hasFigure = true;
      this.label(batch);
    }
    return batch.run ?? 0;
  }

  forget(notebook: string): void {
    this.notebooks.delete(notebook);
  }

  /** Files a count-less summary under the burst it arrived in. */
  private burst(state: NotebookRuns, cellIndex: number, now: number): Batch {
    let burst = state.burst;
    // A Run All runs each cell once: the same cell again is another burst.
    if (
      burst === undefined ||
      burst.closed ||
      burst.cells.has(cellIndex) ||
      now - state.lastBurst > QUEUE_GAP_MS
    ) {
      burst = {
        run: undefined,
        cells: new Set(),
        closed: false,
        executionOrder: undefined,
        hasFigure: false,
        runAll: undefined,
      };
      state.burst = burst;
    }
    burst.cells.add(cellIndex);
    state.lastBurst = now;
    state.seen.set(cellIndex, [...(state.seen.get(cellIndex) ?? []).slice(-1), burst]);
    return burst;
  }

  /** Gives the execution starting on this cell the batch it was queued in. */
  private assign(
    state: NotebookRuns,
    cellIndex: number,
    executionOrder: number | undefined,
    now: number,
  ): Batch {
    // Queue then start: the older of the two. A kernel that sent a single
    // summary, or none, falls back on what there is.
    const batch = state.seen.get(cellIndex)?.[0] ?? this.burst(state, cellIndex, now);
    batch.run ??= this.nextRun++;
    if (batch.cells.size === 1 && executionOrder !== undefined) {
      batch.executionOrder = executionOrder; // a lone run is named after its count
    }
    state.batchOfCell.set(cellIndex, batch);
    // A kernel that sends no count repeats its count-less summary while the
    // cell runs: from here on those say nothing about this execution.
    state.seen.delete(cellIndex);
    state.running.add(cellIndex);
    if (state.burst !== undefined) {
      state.burst.closed = true;
    }
    this.label(batch);
    return batch;
  }

  private stateOf(notebook: string): NotebookRuns {
    let state = this.notebooks.get(notebook);
    if (state === undefined) {
      state = {
        seen: new Map(),
        running: new Set(),
        ended: new Map(),
        batchOfCell: new Map(),
        lastBurst: -Infinity,
        burst: undefined,
      };
      this.notebooks.set(notebook, state);
    }
    return state;
  }

  /**
   * A Run All only takes a number once it drew a figure: batches that never
   * reach the strip must not leave gaps in the numbering the user reads.
   */
  private label(batch: Batch): void {
    if (batch.run === undefined) {
      return;
    }
    if (batch.cells.size < 2) {
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
