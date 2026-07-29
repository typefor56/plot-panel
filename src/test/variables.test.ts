import * as assert from 'assert';
import {
  CATEGORY_ORDER,
  categorize,
  formatVariableValue,
  groupAndSort,
  typeHint,
} from '../variables/categorize';
import { INSPECT_SENTINEL, buildInspectCode, parseInspectReply } from '../variables/inspect';
import { parseDataFrameSummary } from '../variables/summary';

suite('variables: categorization', () => {
  test('pandas/polars tables are DATA', () => {
    assert.strictEqual(categorize('pandas.core.frame.DataFrame'), 'data');
    assert.strictEqual(categorize('pandas.core.series.Series'), 'data');
    assert.strictEqual(categorize('pandas.core.indexes.base.Index'), 'data');
    assert.strictEqual(categorize('polars.dataframe.frame.DataFrame'), 'data');
  });

  test('numpy arrays are VALUES, like in Positron', () => {
    assert.strictEqual(categorize('numpy.ndarray'), 'values');
  });

  test('callables are FUNCTIONS', () => {
    assert.strictEqual(categorize('function'), 'functions');
    assert.strictEqual(categorize('builtin_function_or_method'), 'functions');
    assert.strictEqual(categorize('method'), 'functions');
    assert.strictEqual(categorize('numpy.ufunc'), 'functions');
    assert.strictEqual(categorize('functools.partial'), 'functions');
  });

  test('class definitions are CLASSES', () => {
    assert.strictEqual(categorize('type'), 'classes');
    assert.strictEqual(categorize('abc.ABCMeta'), 'classes');
    assert.strictEqual(categorize('enum.EnumMeta'), 'classes');
  });

  test('everything else is VALUES', () => {
    for (const type of [
      'str',
      'int',
      'float',
      'bool',
      'list',
      'dict',
      'numpy.int64',
      'scipy.stats._kde.gaussian_kde',
      'matplotlib.figure.Figure',
    ]) {
      assert.strictEqual(categorize(type), 'values', type);
    }
  });

  test('type hints shorten qualified names and count indexed children', () => {
    assert.strictEqual(typeHint('float', 0), 'float');
    assert.strictEqual(typeHint('list', 12), 'list (12)');
    assert.strictEqual(typeHint('pandas.core.frame.DataFrame', 0), 'pandas.DataFrame');
    assert.strictEqual(typeHint('polars.dataframe.frame.DataFrame', 0), 'polars.DataFrame');
    assert.strictEqual(typeHint('numpy.ndarray', 0), 'numpy.ndarray');
    assert.strictEqual(typeHint('scipy.stats._kde.gaussian_kde', 0), 'gaussian_kde');
    assert.strictEqual(typeHint('numpy.int64', 245), 'int64 (245)');
  });

  test('values render Positron-style: DataFrame shape, unwrapped arrays, one line', () => {
    const dataFrameRepr =
      '       vru+line  call_id\n0        AA0101    33116\n...\n\n[444448 rows x 24 columns]';
    assert.strictEqual(
      formatVariableValue('pandas.core.frame.DataFrame', dataFrameRepr),
      '[444448 rows x 24 columns] pandas.DataFrame',
    );
    // Without the shape tail (tiny frame), the repr is flattened instead.
    assert.strictEqual(
      formatVariableValue('pandas.core.frame.DataFrame', '   a\n0  1'),
      'a 0 1',
    );
    assert.strictEqual(
      formatVariableValue('numpy.ndarray', 'array([ 5,  7,\n        2])'),
      '[ 5, 7, 2]',
    );
    assert.strictEqual(formatVariableValue('str', "'./data/calls/'"), "'./data/calls/'");
  });

  test('grouping keeps the section order and sorts names case-insensitively', () => {
    const grouped = groupAndSort([
      { name: 'zeta', type: 'int' },
      { name: 'Alpha', type: 'str' },
      { name: 'df', type: 'pandas.core.frame.DataFrame' },
      { name: 'helper', type: 'function' },
    ]);
    assert.deepStrictEqual(
      [...grouped.keys()],
      ['data', 'values', 'functions'],
      'empty categories are omitted, order is fixed',
    );
    assert.ok(
      [...grouped.keys()].every((key) => CATEGORY_ORDER.includes(key)),
      'only known categories appear',
    );
    assert.deepStrictEqual(
      grouped.get('values')?.map((variable) => variable.name),
      ['Alpha', 'zeta'],
    );
  });
});

suite('variables: DataFrame summary (df.info) parsing', () => {
  const SUMMARY = [
    "<class 'pandas.core.frame.DataFrame'>",
    'RangeIndex: 444448 entries, 0 to 444447',
    'Data columns (total 3 columns):',
    ' #   Column       Non-Null Count   Dtype ',
    '---  ------       --------------   ----- ',
    ' 0   vru+line     444448 non-null  object',
    ' 1   call id      444448 non-null  int64 ',
    ' 2   priority     444440 non-null  float64',
    'dtypes: float64(1), int64(1), object(1)',
    'memory usage: 10.2+ MB',
  ].join('\n');

  test('columns come back with non-null counts and dtypes', () => {
    const columns = parseDataFrameSummary(SUMMARY);
    assert.ok(columns);
    assert.deepStrictEqual(columns, [
      { name: 'vru+line', nonNull: '444448 non-null', dtype: 'object' },
      // A column name containing a space survives the parse.
      { name: 'call id', nonNull: '444448 non-null', dtype: 'int64' },
      { name: 'priority', nonNull: '444440 non-null', dtype: 'float64' },
    ]);
  });

  test('wide-frame summaries without the per-column table yield undefined', () => {
    const wide = [
      "<class 'pandas.core.frame.DataFrame'>",
      'RangeIndex: 4082 entries, 0 to 4081',
      'Columns: 108 entries, subjectid to xyz',
      'dtypes: float64(100), object(8)',
    ].join('\n');
    assert.strictEqual(parseDataFrameSummary(wide), undefined);
    assert.strictEqual(parseDataFrameSummary(''), undefined);
  });
});

suite('variables: kernel inspection protocol', () => {
  test('the snippet embeds the expression double-encoded, immune to quoting', () => {
    const expression = 'calls["vru+line"]';
    const code = buildInspectCode(expression);
    assert.ok(code.includes(JSON.stringify(JSON.stringify(expression))), 'double-encoded target');
    assert.ok(code.includes('json.loads'), 'decoded kernel-side');
    assert.ok(
      !code.includes(INSPECT_SENTINEL),
      'the code never contains the assembled sentinel (echoes cannot fake a reply)',
    );
  });

  test('a valid sentinel line is parsed out of noisy output', () => {
    const children = [
      { name: 'call_id', expression: 'calls["call_id"]', type: 'pandas.core.series.Series', value: '[33116, ...]', hasChildren: true },
    ];
    const text = `warning: something\n${INSPECT_SENTINEL}${JSON.stringify(children)}\ntrailing`;
    assert.deepStrictEqual(parseInspectReply(text), children);
  });

  test('malformed payloads yield undefined, malformed items are skipped', () => {
    assert.strictEqual(parseInspectReply('no sentinel here'), undefined);
    assert.strictEqual(parseInspectReply(`${INSPECT_SENTINEL}{not json`), undefined);
    const mixed = [
      { name: 'ok', expression: 'x.ok', type: 'int', value: '1', hasChildren: false },
      { name: 'broken' },
    ];
    assert.deepStrictEqual(parseInspectReply(`${INSPECT_SENTINEL}${JSON.stringify(mixed)}`), [
      mixed[0],
    ]);
  });
});
