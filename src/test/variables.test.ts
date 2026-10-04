import * as assert from 'assert';
import {
  categorize,
  dataViewerType,
  formatVariableValue,
  isConstant,
  organizeVariables,
  sizeLabel,
  typeHint,
  variableSize,
} from '../variables/categorize';
import { ndarrayShape } from '../variables/reprParse';
import { INSPECT_SENTINEL, buildInspectCode, parseInspectReply } from '../variables/inspect';
import { parseDataFrameSummary } from '../variables/summary';
import { definedInCells, trackChanges } from '../variables/variablesView';
import * as vscode from 'vscode';
import * as fx from './reprFixtures';

suite('variables: categorization', () => {
  test('pandas/polars tables are DATA', () => {
    assert.strictEqual(categorize('pandas.core.frame.DataFrame'), 'data');
    assert.strictEqual(categorize('pandas.core.series.Series'), 'data');
    assert.strictEqual(categorize('pandas.core.indexes.base.Index'), 'data');
    assert.strictEqual(categorize('polars.dataframe.frame.DataFrame'), 'data');
  });

  test('numpy arrays are VALUES, like in Positron', () => {
    assert.strictEqual(categorize('np.ndarray'), 'values');
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

  test('definitions recovered from cell source land in their sections', () => {
    // The markers the view attaches when Jupyter filtered the real objects out.
    assert.strictEqual(categorize('function'), 'functions');
    assert.strictEqual(categorize('class'), 'classes');
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
    assert.strictEqual(typeHint('pandas.core.frame.DataFrame', 0), 'pd.DataFrame');
    assert.strictEqual(typeHint('polars.dataframe.frame.DataFrame', 0), 'pl.DataFrame');
    assert.strictEqual(typeHint('np.ndarray', 0), 'np.ndarray');
    assert.strictEqual(typeHint('scipy.stats._kde.gaussian_kde', 0), 'gaussian_kde');
    assert.strictEqual(typeHint('numpy.int64', 245), 'np.int64 (245)');
  });

  test('values render Positron-style: DataFrame shape only, elided items, one line', () => {
    // The shape alone — the right-aligned type hint already names the type.
    assert.strictEqual(
      formatVariableValue('pandas.core.frame.DataFrame', fx.DF_LARGE),
      '[200000 rows x 7 columns]',
    );
    // Without the shape tail (tiny frame), the repr is flattened instead.
    assert.strictEqual(formatVariableValue('pandas.core.frame.DataFrame', '   a\n0  1'), 'a 0 1');
    // Series show an elided preview of their values.
    assert.strictEqual(
      formatVariableValue('pandas.core.series.Series', fx.S_SMALL_NAMED),
      '[5, 7, 2]',
    );
    const largeSeries = formatVariableValue('pandas.core.series.Series', fx.S_INT_LARGE);
    assert.ok(largeSeries.startsWith('[0, 1,'), largeSeries);
    assert.ok(largeSeries.includes('…'), 'gap is visible');
    assert.ok(largeSeries.endsWith('99999]'), largeSeries);
    // Collections keep their own brackets and elide long contents.
    assert.strictEqual(formatVariableValue('np.ndarray', fx.ND_1D), '[5, 7, 2, 3, 3, 1, 23, 2, 11]');
    const bigList = formatVariableValue('list', fx.LIST_1000);
    assert.ok(bigList.startsWith('[0, 1, 2,'), bigList);
    assert.ok(bigList.endsWith('…]'), 'SafeRepr tail cut stays visible');
    const dict = formatVariableValue('dict', fx.DICT_SMALL);
    assert.ok(dict.startsWith("{'january': 31,"), dict);
    // Everything else: whitespace-collapsed repr.
    assert.strictEqual(formatVariableValue('str', "'./data/calls/'"), "'./data/calls/'");
  });

  test('variableSize derives element counts from the stable data only', () => {
    assert.strictEqual(variableSize('pandas.core.frame.DataFrame', fx.DF_LARGE, 0), 1_400_000);
    assert.strictEqual(variableSize('pandas.core.series.Series', fx.S_INT_LARGE, 0), 100_000);
    assert.strictEqual(variableSize('list', fx.LIST_1000, 1000), 1000, 'Jupyter count wins');
    assert.strictEqual(variableSize('np.ndarray', fx.ND_1D, 0), 9, 'complete repr counted');
    assert.strictEqual(variableSize('np.ndarray', fx.ND_BIG, 0), 0, 'truncated repr unknown');
    assert.strictEqual(variableSize('str', "'./data/calls/'", 0), 13);
    assert.strictEqual(variableSize('int', '50', 0), 0);
  });


  test('dataViewerType maps to the viewers’ exact dataTypes members', () => {
    assert.strictEqual(dataViewerType('pandas.core.frame.DataFrame'), 'DataFrame');
    assert.strictEqual(dataViewerType('pandas.core.series.Series'), 'Series');
    assert.strictEqual(dataViewerType('np.ndarray'), 'ndarray');
    assert.strictEqual(dataViewerType('list'), 'list');
    assert.strictEqual(dataViewerType('dict'), 'dict');
    assert.strictEqual(dataViewerType('str'), undefined);
    assert.strictEqual(dataViewerType('set'), undefined);
    assert.strictEqual(dataViewerType('matplotlib.figure.Figure'), undefined);
  });

  test('kind grouping keeps section order and sorts names case-insensitively', () => {
    const sections = organizeVariables(
      [
        { name: 'zeta', type: 'int', size: 0, changedAt: 0 },
        { name: 'Alpha', type: 'str', size: 5, changedAt: 0 },
        { name: 'df', type: 'pandas.core.frame.DataFrame', size: 100, changedAt: 0 },
        { name: 'helper', type: 'function', size: 0, changedAt: 0 },
      ],
      'kind',
      'name',
    );
    assert.deepStrictEqual(
      sections.map((section) => section.label),
      ['DATA', 'VALUES', 'FUNCTIONS'],
      'empty categories are omitted, order is fixed',
    );
    assert.deepStrictEqual(
      sections[1]?.rows.map((row) => row.name),
      ['Alpha', 'zeta'],
    );
  });

  test('size grouping buckets by magnitude with exact thresholds', () => {
    const variable = (name: string, size: number) => ({
      name,
      type: 'int',
      size,
      changedAt: 0,
    });
    const sections = organizeVariables(
      [
        variable('big', 100_000),
        variable('nearlyBig', 99_999),
        variable('medium', 1_000),
        variable('small', 999),
        variable('tiny', 0),
      ],
      'size',
      'size',
    );
    assert.deepStrictEqual(
      sections.map((section) => [section.label, section.rows.map((row) => row.name)]),
      [
        ['LARGE', ['big']],
        ['MEDIUM', ['nearlyBig', 'medium']],
        ['SMALL', ['small', 'tiny']],
      ],
    );
  });

  test('sorting applies within sections: size desc and recent desc, ties by name', () => {
    const variables = [
      { name: 'b', type: 'int', size: 10, changedAt: 5 },
      { name: 'a', type: 'int', size: 10, changedAt: 5 },
      { name: 'c', type: 'int', size: 99, changedAt: 1 },
    ];
    const bySize = organizeVariables(variables, 'kind', 'size');
    assert.deepStrictEqual(
      bySize[0]?.rows.map((row) => row.name),
      ['c', 'a', 'b'],
    );
    const byRecent = organizeVariables(variables, 'kind', 'recent');
    assert.deepStrictEqual(
      byRecent[0]?.rows.map((row) => row.name),
      ['a', 'b', 'c'],
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

suite('variables: value and size columns', () => {
  test('only constants show their value', () => {
    for (const type of ['float', 'int', 'str', 'bool', 'NoneType', 'numpy.float64', 'int64']) {
      assert.strictEqual(isConstant(type, 0), true, type);
    }
    for (const type of ['list', 'numpy.ndarray', 'pandas.core.frame.DataFrame', 'dict']) {
      assert.strictEqual(isConstant(type, 3), false, type);
    }
    assert.strictEqual(isConstant('numeric', 1), true, 'R scalar');
    assert.strictEqual(isConstant('numeric', 10), false, 'R vector');
  });

  test('size is a numpy-style shape for arrays and tables, else a length', () => {
    assert.match(sizeLabel('pandas.core.frame.DataFrame', fx.DF_LARGE, 0), /^\(\d+, \d+\)$/);
    const info =
      "<class 'pandas.core.frame.DataFrame'>\nRangeIndex: 2 entries, 0 to 1\n" +
      'Data columns (total 2 columns):\n';
    assert.strictEqual(sizeLabel('pandas.core.frame.DataFrame', '   a  b\n0  1  3', 0, info), '(2, 2)');
    assert.strictEqual(sizeLabel('numpy.ndarray', 'array([0., 1., 2.])', 3), '(3,)');
    assert.strictEqual(sizeLabel('list', '[1, 2]', 15), '15');
    assert.strictEqual(sizeLabel('dict', fx.DICT_SMALL, 0), '4');
    assert.strictEqual(sizeLabel('float', '2.0', 0), '');
    assert.strictEqual(sizeLabel('str', "'abc'", 0), '3');
  });

  test('numpy scalars: the number as value, np.<type> as type', () => {
    assert.strictEqual(formatVariableValue('numpy.int64', 'np.int64(8)'), '8');
    assert.strictEqual(formatVariableValue('numpy.float64', 'np.float64(7.44)'), '7.44');
    assert.strictEqual(
      formatVariableValue('list', '[np.float64(3.25), np.float64(3.29)]'),
      '[3.25, 3.29]',
    );
    assert.strictEqual(typeHint('numpy.int64', 0), 'np.int64');
    assert.strictEqual(typeHint('numpy.float64', 0), 'np.float64');
    assert.strictEqual(typeHint('float', 0), 'float');
  });

  test('ndarray shapes, from reprs produced by numpy 2', () => {
    const cases: readonly (readonly [string, number, string])[] = [
      ['array([0., 1., 2., 3., 4., 5., 6., 7., 8., 9.])', 10, '(10,)'],
      ['array([[0., 0., 0.],\n       [0., 0., 0.]])', 2, '(2, 3)'],
      [
        'array([[[0., 0., 0., 0.],\n        [0., 0., 0., 0.],\n        [0., 0., 0., 0.]],\n\n' +
          '       [[0., 0., 0., 0.],\n        [0., 0., 0., 0.],\n        [0., 0., 0., 0.]]])',
        2,
        '(2, 3, 4)',
      ],
      [
        'array([[0., 0., 0., ..., 0., 0., 0.],\n       ...,\n       [0., 0., 0., ..., 0., 0., 0.]], shape=(100, 100))',
        100,
        '(100, 100)',
      ],
      ['array([], shape=(5, 0), dtype=float64)', 5, '(5, 0)'],
      ["array(['a, b', 'c]'], dtype='<U4')", 2, '(2,)'],
      ['array([], dtype=float64)', 0, '(0,)'],
      // numpy 1.x summaries carry no shape: count the first axis, never guess the rest.
      ['array([[0., 0., ..., 0.],\n       ...,\n       [0., 0., ..., 0.]])', 100, '(100, …)'],
      ['array([[1, 2, 3],\n       ...,\n       [7, 8, 9]])', 1000, '(1000, 3)'],
    ];
    for (const [raw, count, expected] of cases) {
      assert.strictEqual(ndarrayShape(raw, count), expected, raw);
    }
    assert.strictEqual(ndarrayShape('<object at 0x1>', 0), undefined);
  });
});

suite('variables: definitions read from executed cells', () => {
  test('a reopened notebook shows no FUNCTIONS/CLASSES until its cells run again', async () => {
    const start = Date.now();
    const saved = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'def old():\n    pass', 'python');
    saved.executionSummary = { executionOrder: 3 }; // a count kept in the .ipynb, no run time
    const ran = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, 'class Fresh:\n    pass', 'python');
    ran.executionSummary = { executionOrder: 1, timing: { startTime: start + 5, endTime: start + 10 } };
    const notebook = await vscode.workspace.openNotebookDocument(
      'jupyter-notebook',
      new vscode.NotebookData([saved, ran]),
    );
    assert.deepStrictEqual(
      definedInCells(notebook, start).map((definition) => definition.name),
      ['Fresh'],
    );
  });
});

suite('variables: highlighting what a run changed', () => {
  const variable = (name: string, value: string) => ({
    name,
    value,
    type: 'int',
    expression: name,
    hasNamedChildren: false,
    indexedChildrenCount: 0,
  });

  test('a first listing with no execution behind it marks nothing', () => {
    const epoch = new Set<string>();
    trackChanges(new Map(), epoch, [variable('a', '1'), variable('b', '2')], false, 1);
    assert.deepStrictEqual([...epoch], []);
  });

  test('a first listing after an execution marks everything it created', () => {
    const known = new Map<string, { signature: string; changedAt: number }>();
    const epoch = new Set<string>();
    trackChanges(known, epoch, [variable('a', '1'), variable('b', '2')], true, 1);
    assert.deepStrictEqual([...epoch], ['a', 'b']);
    // The same run going on: only what moved or appeared joins.
    epoch.clear();
    trackChanges(known, epoch, [variable('a', '1'), variable('b', '3'), variable('c', '4')], true, 2);
    assert.deepStrictEqual([...epoch], ['b', 'c']);
  });
});
