import * as assert from 'assert';
import { groupIntoRuns, type Runnable } from '../runs';

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
