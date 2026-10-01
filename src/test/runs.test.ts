import * as assert from 'assert';
import { QUEUE_GAP_MS, RunTracker, groupIntoRuns, runAllOrdinal, type Runnable } from '../runs';

const NB = 'file:///nb.ipynb';

function entry(cellIndex: number | undefined, timestamp: number, uri = NB): Runnable {
  return { timestamp, notebookUri: uri, ...(cellIndex === undefined ? {} : { cellIndex }) };
}

function shape(entries: readonly Runnable[]): readonly number[] {
  return groupIntoRuns(entries).map((group) => group.count);
}

suite('plot history: runs', () => {
  test('a run walks down the notebook; going back up starts the next', () => {
    const entries = [
      entry(0, 1000),
      entry(2, 1100),
      entry(5, 1200), // run 1: three figures
      entry(0, 1300),
      entry(3, 1400), // run 2: two figures
    ];
    assert.deepStrictEqual(shape(entries), [3, 2]);
    assert.deepStrictEqual(
      groupIntoRuns(entries).map((group) => [group.run, group.startIndex]),
      [
        [1, 0],
        [2, 3],
      ],
    );
  });

  test('several figures from one execution stay in the same run', () => {
    // A cell looping over plt.show() draws many figures with one execution
    // count; treating each as a run turned a single Run All into five.
    const entries = [
      { timestamp: 1000, notebookUri: NB, cellIndex: 3, executionOrder: 7 },
      { timestamp: 1010, notebookUri: NB, cellIndex: 3, executionOrder: 7 },
      { timestamp: 1020, notebookUri: NB, cellIndex: 3, executionOrder: 7 },
      { timestamp: 1030, notebookUri: NB, cellIndex: 8, executionOrder: 8 },
    ];
    assert.deepStrictEqual(shape(entries), [4]);
  });

  test('re-running the same cell counts as a new run', () => {
    const entries = [
      { timestamp: 1000, notebookUri: NB, cellIndex: 4, executionOrder: 1 },
      { timestamp: 2000, notebookUri: NB, cellIndex: 4, executionOrder: 2 },
      { timestamp: 3000, notebookUri: NB, cellIndex: 4, executionOrder: 3 },
    ];
    assert.deepStrictEqual(shape(entries), [1, 1, 1]);
    // Without execution counts (an older store) the cell alone has to decide.
    assert.deepStrictEqual(shape([entry(4, 1000), entry(4, 2000)]), [1, 1]);
  });

  test('another notebook always starts a run', () => {
    const entries = [entry(0, 1000), entry(1, 1100), entry(2, 1200, 'file:///other.ipynb')];
    assert.deepStrictEqual(shape(entries), [2, 1]);
  });

  test('without cell metadata a long silence separates runs', () => {
    const entries = [
      entry(undefined, 0),
      entry(undefined, 5_000),
      entry(undefined, 200_000),
    ];
    assert.deepStrictEqual(shape(entries), [2, 1]);
  });

  test('the groups always cover the whole history', () => {
    const entries = [entry(0, 0), entry(1, 10), entry(0, 20), entry(9, 30)];
    const total = groupIntoRuns(entries).reduce((sum, group) => sum + group.count, 0);
    assert.strictEqual(total, entries.length);
    assert.deepStrictEqual(groupIntoRuns([]), []);
  });
});

suite('plot history: execution batches', () => {
  function tracker(): { runs: RunTracker; labels: Map<number, string> } {
    const labels = new Map<number, string>();
    return { runs: new RunTracker((run, label) => labels.set(run, label)), labels };
  }

  test('Run All queues every cell at once: one batch, numbered once it draws', () => {
    const { runs, labels } = tracker();
    // Event sequence recorded from a real extension host.
    for (const cell of [0, 1, 2]) {
      runs.observe('nb', cell, undefined, false, 1000);
    }
    runs.observe('nb', 0, 1, false, 1050);
    const run = runs.runOf('nb', 0, 1, 1100);
    assert.strictEqual(labels.get(run), 'Run all 1');
    runs.observe('nb', 0, 1, true, 5000); // a slow cell: still the same run
    runs.observe('nb', 1, 2, false, 5010);
    assert.strictEqual(runs.runOf('nb', 1, 2, 6000), run);
  });

  test('a lone cell run is named after its execution count', () => {
    const { runs, labels } = tracker();
    runs.observe('nb', 3, undefined, false, 1000);
    runs.observe('nb', 3, 12, false, 1010);
    const run = runs.runOf('nb', 3, 12, 1100);
    assert.strictEqual(labels.get(run), 'Run 12');
    runs.observe('nb', 3, 12, true, 1200);
    runs.observe('nb', 3, 12, false, 1250); // late echo, not a new execution
    assert.strictEqual(runs.runOf('nb', 3, 12, 1260), run);
  });

  test('a second Run All gets the next number; a pause splits batches', () => {
    const { runs, labels } = tracker();
    const runAll = (at: number): number => {
      runs.observe('nb', 0, undefined, false, at);
      runs.observe('nb', 1, undefined, false, at);
      return runs.runOf('nb', 0, undefined, at + 10);
    };
    const first = runAll(1000);
    runs.observe('nb', 0, 1, true, 1100);
    runs.observe('nb', 1, 2, true, 1200);
    const second = runAll(1200 + QUEUE_GAP_MS + 1);
    assert.notStrictEqual(first, second);
    assert.strictEqual(labels.get(second), 'Run all 2');
  });

  test('running a cell again right away is a new batch, not a Run All', () => {
    const { runs } = tracker();
    runs.observe('nb', 0, undefined, false, 1000);
    const first = runs.runOf('nb', 0, 1, 1010);
    runs.observe('nb', 0, 1, true, 1020);
    runs.observe('nb', 0, undefined, false, 1030);
    assert.notStrictEqual(runs.runOf('nb', 0, 2, 1040), first);
  });

  test('a cell pending since a cancelled Run All runs as a fresh execution', () => {
    const { runs } = tracker();
    runs.observe('nb', 0, undefined, false, 1000);
    runs.observe('nb', 1, undefined, false, 1000);
    const cancelled = runs.runOf('nb', 0, 1, 1010);
    runs.observe('nb', 0, 1, true, 1020); // interrupted: cell 1 never ends
    runs.observe('nb', 1, undefined, false, 9000);
    assert.notStrictEqual(runs.runOf('nb', 1, 3, 9010), cancelled);
  });

  test('a multi-cell batch that draws nothing leaves no gap in the numbering', () => {
    const { runs, labels } = tracker();
    runs.observe('nb', 0, undefined, false, 1000); // e.g. Clear All Outputs
    runs.observe('nb', 1, undefined, false, 1000);
    runs.observe('nb', 0, undefined, false, 9000);
    runs.observe('nb', 1, undefined, false, 9000);
    assert.strictEqual(labels.get(runs.runOf('nb', 1, undefined, 9100)), 'Run all 1');
  });

  test('entries carrying a batch group by it; restored labels resume the count', () => {
    const entries = [
      { timestamp: 1, notebookUri: NB, cellIndex: 5, run: 4 },
      { timestamp: 2, notebookUri: NB, cellIndex: 0, run: 4 },
      { timestamp: 3, notebookUri: NB, cellIndex: 9, run: 5 },
    ];
    assert.deepStrictEqual(shape(entries), [2, 1]);
    assert.strictEqual(runAllOrdinal('Run all 7'), 7);
    assert.strictEqual(runAllOrdinal('Run 7'), 0);
  });
});
