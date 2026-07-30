import * as assert from 'assert';
import { ExpandRegistry, type PreviewRow } from '../variables/expandTree';
import {
  DF_LARGE,
  DF_SMALL,
  DF_TIGHT_HEADER,
  DICT_SMALL,
  LIST_SMALL,
  ND_BIG,
  S_DATETIME,
  S_INT_LARGE,
  S_NAMED_INDEX,
  S_SMALL_NAMED,
} from './reprFixtures';

/** df.info() output matching DF_SMALL, as Jupyter attaches it. */
const DF_SMALL_SUMMARY = [
  "<class 'pandas.core.frame.DataFrame'>",
  'RangeIndex: 3 entries, 0 to 2',
  'Data columns (total 3 columns):',
  ' #   Column    Non-Null Count  Dtype  ',
  '---  ------    --------------  -----  ',
  ' 0   vru+line  3 non-null      object ',
  ' 1   call id   3 non-null      int64  ',
  ' 2   priority  3 non-null      float64',
  'dtypes: float64(1), int64(1), object(1)',
].join('\n');

function registry(type: string, raw: string, summary?: string) {
  const tree = new ExpandRegistry();
  const expandable = tree.register('root', {
    type,
    raw,
    summary,
    expression: 'root',
  });
  return { tree, expandable };
}

function names(rows: readonly PreviewRow[] | undefined): readonly string[] {
  return (rows ?? []).map((row) => row.name);
}

suite('expansion: pandas Series', () => {
  test('a Series opens into an index | value table', () => {
    const { tree, expandable } = registry('pandas.core.series.Series', S_SMALL_NAMED);
    assert.strictEqual(expandable, true);
    const rows = tree.childrenOf('root');
    assert.deepStrictEqual(names(rows), ['0', '1', '2']);
    assert.deepStrictEqual(
      rows?.map((row) => row.value),
      ['5', '7', '2'],
    );
  });

  test('a datetime index keeps its label intact', () => {
    const { tree } = registry('pandas.core.series.Series', S_DATETIME);
    const rows = tree.childrenOf('root');
    assert.strictEqual(rows?.[0]?.name, '1999-01-01');
    assert.strictEqual(rows?.[0]?.value, '0');
  });

  test('the truncation row sits where pandas elided the data', () => {
    const { tree } = registry('pandas.core.series.Series', S_INT_LARGE);
    const rows = tree.childrenOf('root') ?? [];
    const gap = rows.findIndex((row) => row.kind === 'ellipsis');
    assert.strictEqual(gap, 5, 'the marker should follow the five head rows');
    assert.strictEqual(rows[gap + 1]?.name, '99995');
  });

  test('table rows carry no expression, so no viewer button', () => {
    const { tree } = registry('pandas.core.series.Series', S_SMALL_NAMED);
    for (const row of tree.childrenOf('root') ?? []) {
      assert.strictEqual(row.expression, '');
      assert.strictEqual(row.viewerType, undefined);
    }
  });
});

suite('expansion: shapes taken from a real notebook', () => {
  test('a groupby Series expands despite its named index line', () => {
    const { tree, expandable } = registry('pandas.core.series.Series', S_NAMED_INDEX);
    assert.strictEqual(expandable, true, 'the chevron never appeared for this Series');
    const rows = tree.childrenOf('root');
    assert.deepStrictEqual(names(rows), ['1999-01-01', '1999-01-04', '1999-01-05']);
    assert.deepStrictEqual(
      rows?.map((row) => row.value),
      ['5', '7', '2'],
    );
  });

  test('a frame whose header names touch still yields every column', () => {
    const { tree, expandable } = registry('pandas.core.frame.DataFrame', DF_TIGHT_HEADER);
    assert.strictEqual(expandable, true);
    const columns = tree.childrenOf('root') ?? [];
    // 18 columns: splitting the header on two spaces only ever found 13.
    assert.strictEqual(columns.length, 18);
    assert.deepStrictEqual(names(columns).slice(0, 5), [
      'vru+line',
      'call_id',
      'customer_id',
      'priority',
      'type',
    ]);
    const cells = tree.childrenOf(columns[3]?.nodeId ?? '');
    assert.deepStrictEqual(
      cells?.map((row) => row.value),
      ['2', '0', '2'],
    );
  });
});

suite('expansion: pandas DataFrame', () => {
  test('columns come from df.info, each opening into its own table', () => {
    const { tree, expandable } = registry(
      'pandas.core.frame.DataFrame',
      DF_SMALL,
      DF_SMALL_SUMMARY,
    );
    assert.strictEqual(expandable, true);

    const columns = tree.childrenOf('root');
    assert.deepStrictEqual(names(columns), ['vru+line', 'call id', 'priority']);
    assert.strictEqual(columns?.[0]?.value, '3 non-null');
    assert.strictEqual(columns[0]?.typeHint, 'object');
    // A column is a Series, and the viewer can resolve the expression.
    assert.strictEqual(columns[0]?.expression, 'root["vru+line"]');
    assert.strictEqual(columns[0]?.viewerType, 'Series');
    assert.strictEqual(columns[0]?.expandable, true);

    const cells = tree.childrenOf(columns[0]?.nodeId ?? '');
    assert.deepStrictEqual(names(cells), ['0', '1', '2']);
    assert.deepStrictEqual(
      cells?.map((row) => row.value),
      ['AA0101', 'AA0102', 'BB0101'],
    );
  });

  test('a column keeps the frame truncation marker', () => {
    const { tree } = registry('pandas.core.frame.DataFrame', DF_LARGE);
    const columns = tree.childrenOf('root');
    const cells = tree.childrenOf(columns?.[1]?.nodeId ?? '') ?? [];
    assert.ok(cells.some((row) => row.kind === 'ellipsis'));
  });

  test('without df.info the columns still come from the grid', () => {
    const { tree } = registry('pandas.core.frame.DataFrame', DF_SMALL);
    assert.deepStrictEqual(names(tree.childrenOf('root')), [
      'vru+line',
      'call id',
      'priority',
    ]);
  });
});

suite('expansion: containers, recursively', () => {
  test('a list of DataFrames opens into frames, then columns, then rows', () => {
    // What a list of frames looks like through SafeRepr: each item is the
    // frame's own repr, comma-separated at the top level.
    const raw = `[${DF_SMALL}, ${DF_SMALL}]`;
    const { tree, expandable } = registry('list', raw);
    assert.strictEqual(expandable, true);

    const frames = tree.childrenOf('root') ?? [];
    assert.strictEqual(frames.length, 2);
    assert.strictEqual(frames[0]?.typeHint, 'pandas.DataFrame');
    assert.strictEqual(frames[0]?.expression, 'root[0]');
    assert.strictEqual(frames[0]?.expandable, true);

    const columns = tree.childrenOf(frames[0]?.nodeId ?? '') ?? [];
    assert.deepStrictEqual(names(columns), ['vru+line', 'call id', 'priority']);

    const cells = tree.childrenOf(columns[2]?.nodeId ?? '');
    assert.deepStrictEqual(
      cells?.map((row) => row.value),
      ['0.0', '2.0', '1.0'],
    );
  });

  test('nesting keeps opening as long as the repr shows something', () => {
    const { tree } = registry('list', '[[1, 2], [3, [4, 5]]]');
    const level1 = tree.childrenOf('root') ?? [];
    assert.strictEqual(level1.length, 2);

    const level2 = tree.childrenOf(level1[1]?.nodeId ?? '') ?? [];
    assert.deepStrictEqual(
      level2.map((row) => row.value),
      ['3', '[4, 5]'],
    );

    const level3 = tree.childrenOf(level2[1]?.nodeId ?? '') ?? [];
    assert.deepStrictEqual(
      level3.map((row) => row.value),
      ['4', '5'],
    );
  });

  test('a dict opens into key | value and indexes with the literal key', () => {
    const { tree } = registry('dict', DICT_SMALL);
    const rows = tree.childrenOf('root') ?? [];
    assert.strictEqual(rows[0]?.name, "'january'");
    assert.strictEqual(rows[0]?.value, '31');
    assert.strictEqual(rows[0]?.expression, "root['january']");
  });

  test('a plain list is addressable by position', () => {
    const { tree } = registry('list', LIST_SMALL);
    const rows = tree.childrenOf('root') ?? [];
    assert.deepStrictEqual(names(rows).slice(0, 3), ['0', '1', '2']);
    assert.strictEqual(rows[1]?.expression, 'root[1]');
  });

  test('positions after a numpy gap are left blank rather than wrong', () => {
    const { tree } = registry('numpy.ndarray', ND_BIG);
    const rows = tree.childrenOf('root') ?? [];
    const gap = rows.findIndex((row) => row.kind === 'ellipsis');
    assert.ok(gap > 0);
    assert.strictEqual(rows[gap + 1]?.name, '');
    assert.strictEqual(rows[gap + 1]?.expression, '');
  });

  test('scalars are leaves', () => {
    const { tree } = registry('list', LIST_SMALL);
    const rows = tree.childrenOf('root') ?? [];
    assert.strictEqual(rows[0]?.expandable, false);
    assert.strictEqual(tree.childrenOf(rows[0]?.nodeId ?? ''), undefined);
  });

  test('an unknown node id yields nothing rather than throwing', () => {
    const { tree } = registry('list', LIST_SMALL);
    assert.strictEqual(tree.childrenOf('nope'), undefined);
  });
});
