import * as assert from 'assert';
import {
  elideItems,
  parseCollectionRepr,
  parseDataFrameRepr,
  parseSeriesRepr,
  splitDictItem,
} from '../variables/reprParse';
import * as fx from './reprFixtures';

suite('reprParse: pandas Series', () => {
  test('large int series: pairs, gap position and Length tail', () => {
    const parsed = parseSeriesRepr(fx.S_INT_LARGE);
    assert.ok(parsed);
    assert.strictEqual(parsed.pairs.length, 10);
    assert.deepStrictEqual(parsed.pairs[0], ['0', '0']);
    assert.deepStrictEqual(parsed.pairs.at(-1), ['99999', '99999']);
    assert.strictEqual(parsed.gapAt, 5);
    assert.strictEqual(parsed.length, 100000);
    assert.strictEqual(parsed.dtype, 'int64');
  });

  test('datetime index survives (single spaces inside the index)', () => {
    const parsed = parseSeriesRepr(fx.S_TS_INDEX);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed.pairs, [
      ['2021-01-01 00:00:01', '1.5'],
      ['2021-01-02 12:30:45', '2.5'],
    ]);
    assert.strictEqual(parsed.gapAt, undefined);
    assert.strictEqual(parsed.length, 2);
    assert.strictEqual(parsed.dtype, 'float64');
  });

  test('date_range series parses Freq/Name/Length tail', () => {
    const parsed = parseSeriesRepr(fx.S_DATETIME);
    assert.ok(parsed);
    assert.strictEqual(parsed.length, 200);
    assert.strictEqual(parsed.gapAt, 5);
    assert.deepStrictEqual(parsed.pairs[0], ['1999-01-01', '0']);
  });

  test('object series and named series parse; empty series yields no pairs', () => {
    const objects = parseSeriesRepr(fx.S_OBJ);
    assert.ok(objects);
    assert.deepStrictEqual(objects.pairs[1], ['1', 'february']);
    const named = parseSeriesRepr(fx.S_SMALL_NAMED);
    assert.ok(named);
    assert.strictEqual(named.pairs.length, 3);
    assert.strictEqual(named.length, 3);
    const empty = parseSeriesRepr(fx.S_EMPTY);
    assert.ok(empty);
    assert.deepStrictEqual(empty.pairs, []);
    assert.strictEqual(empty.length, 0);
    assert.strictEqual(empty.dtype, 'object');
  });

  test('MultiIndex series parses with cosmetically flattened indexes', () => {
    // Documented limitation: continuation lines lose the blank outer level.
    const parsed = parseSeriesRepr(fx.S_MULTI);
    assert.ok(parsed);
    assert.deepStrictEqual(parsed.pairs[0], ['a  1', '10']);
    assert.deepStrictEqual(parsed.pairs[1], ['2', '20']);
  });

  test('non-series text is rejected', () => {
    assert.strictEqual(parseSeriesRepr('0.7'), undefined);
    assert.strictEqual(parseSeriesRepr('<Axes: title=...>'), undefined);
    assert.strictEqual(parseSeriesRepr(''), undefined);
  });
});

suite('reprParse: pandas DataFrame grid', () => {
  test('small frame: header (spaced column name), rows, no gap', () => {
    const grid = parseDataFrameRepr(fx.DF_SMALL);
    assert.ok(grid);
    assert.deepStrictEqual(grid.columns, ['vru+line', 'call id', 'priority']);
    assert.strictEqual(grid.rows.length, 3);
    assert.deepStrictEqual(grid.rows[0], {
      index: '0',
      cells: ['AA0101', '33116', '0.0'],
    });
    assert.strictEqual(grid.gapAt, undefined);
  });

  test('large frame: gap row position, shape tail ignored', () => {
    const grid = parseDataFrameRepr(fx.DF_LARGE);
    assert.ok(grid);
    assert.strictEqual(grid.columns.length, 7);
    assert.strictEqual(grid.rows.length, 10);
    assert.strictEqual(grid.gapAt, 5);
    assert.strictEqual(grid.rows[5]?.index, '199995');
  });

  test('>100 columns keeps the literal "..." column (caller skips it)', () => {
    const grid = parseDataFrameRepr(fx.DF_WIDE108);
    assert.ok(grid);
    assert.ok(grid.columns.includes('...'));
    const row = grid.rows[0];
    assert.ok(row);
    assert.strictEqual(row.cells.length, grid.columns.length);
  });

  test('wrapped, MultiIndex and empty frames bail out', () => {
    assert.strictEqual(parseDataFrameRepr(fx.DF_WRAPPED), undefined, 'width-wrapped');
    assert.strictEqual(parseDataFrameRepr(fx.DF_MULTIROW), undefined, 'MultiIndex rows');
    assert.strictEqual(parseDataFrameRepr(fx.DF_MULTICOL), undefined, 'MultiIndex columns');
    assert.strictEqual(parseDataFrameRepr(fx.DF_EMPTY), undefined, 'empty frame');
  });
});

suite('reprParse: collections', () => {
  test('plain and SafeRepr-truncated lists', () => {
    const small = parseCollectionRepr(fx.LIST_SMALL, 'list');
    assert.ok(small);
    assert.strictEqual(small.items.length, 9);
    assert.strictEqual(small.gapAt, undefined);
    const big = parseCollectionRepr(fx.LIST_1000, 'list');
    assert.ok(big);
    assert.strictEqual(big.gapAt, big.items.length, 'SafeRepr cuts at the tail');
    assert.strictEqual(big.items[0], '0');
  });

  test('quoted strings with commas and double spaces stay whole', () => {
    const parsed = parseCollectionRepr(fx.LIST_STRINGS, 'list');
    assert.ok(parsed);
    // Items keep their exact text, inner spacing included: a nested Series or
    // DataFrame is only recognisable while its line structure survives.
    assert.deepStrictEqual(parsed.items, [
      "'a, b'",
      '"it\'s"',
      "'plain'",
      "'  double  spaced  '",
    ]);
  });

  test('a preview of those items is still one flattened line', () => {
    const parsed = parseCollectionRepr(fx.LIST_STRINGS, 'list');
    assert.ok(parsed);
    assert.strictEqual(
      elideItems(parsed.items, parsed.gapAt, 200),
      "'a, b', \"it's\", 'plain', ' double spaced '",
    );
  });

  test('tuples, sets and dicts unwrap with their own brackets', () => {
    const one = parseCollectionRepr(fx.TUPLE_ONE, 'tuple');
    assert.ok(one);
    assert.deepStrictEqual(one.items, ['1']);
    const set = parseCollectionRepr(fx.SET_SMALL, 'set');
    assert.ok(set);
    assert.strictEqual(set.items.length, 3);
    const emptySet = parseCollectionRepr(fx.SET_EMPTY, 'set');
    assert.ok(emptySet);
    assert.deepStrictEqual(emptySet.items, []);
    const dict = parseCollectionRepr(fx.DICT_SMALL, 'dict');
    assert.ok(dict);
    // The tuple key's comma is not a top-level separator.
    assert.strictEqual(dict.items.length, 4);
    assert.strictEqual(dict.items[2], "(1, 2): 'tuple key'");
  });

  test('ndarray: dtype suffix ignored, 2-D rows as items, numpy mid-gap', () => {
    const int8 = parseCollectionRepr(fx.ND_1D, 'numpy.ndarray');
    assert.ok(int8);
    assert.strictEqual(int8.items.length, 9);
    assert.strictEqual(int8.items[0], '5');
    const twoD = parseCollectionRepr(fx.ND_2D, 'numpy.ndarray');
    assert.ok(twoD);
    assert.deepStrictEqual(twoD.items, ['[1., 2.]', '[3., 4.]']);
    const big = parseCollectionRepr(fx.ND_BIG, 'numpy.ndarray');
    assert.ok(big);
    assert.strictEqual(big.gapAt, 3, 'numpy truncates in the middle');
    assert.strictEqual(big.items.length, 6);
    assert.strictEqual(parseCollectionRepr('array(5.0)', 'numpy.ndarray'), undefined, '0-d');
  });

  test('dict items split at the first top-level colon', () => {
    assert.deepStrictEqual(splitDictItem("'january': 31"), ["'january'", '31']);
    assert.deepStrictEqual(splitDictItem("(1, 2): 'tuple key'"), ['(1, 2)', "'tuple key'"]);
    assert.deepStrictEqual(splitDictItem("'url': 'http://x:1'"), ["'url'", "'http://x:1'"]);
    assert.strictEqual(splitDictItem('no colon here'), undefined);
  });
});

suite('reprParse: elision', () => {
  test('fits whole when complete and short', () => {
    assert.strictEqual(elideItems(['1', '2', '3'], undefined, 60), '1, 2, 3');
  });

  test('splices head and tail around the middle when too long', () => {
    const items = Array.from({ length: 50 }, (_, i) => String(i));
    const out = elideItems(items, undefined, 30);
    assert.ok(out.includes('…'));
    assert.ok(out.startsWith('0, 1'));
    assert.ok(out.endsWith('49'));
    assert.ok(out.length <= 34);
  });

  test('honors a data gap: tail only comes from after it', () => {
    const out = elideItems(['a', 'b', 'y', 'z'], 2, 60);
    assert.strictEqual(out, 'a, b, …, y, z');
  });

  test('truncated data always shows the ellipsis even when short', () => {
    assert.strictEqual(elideItems(['1', '2'], 2, 60), '1, 2, …');
  });
});
