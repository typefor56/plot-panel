import * as assert from 'assert';
import { CATEGORY_ORDER, categorize, groupAndSort, typeHint } from '../variables/categorize';
import { INSPECT_SENTINEL, buildInspectCode, parseInspectReply } from '../variables/inspect';

suite('variables: categorization', () => {
  test('table-like containers are DATA', () => {
    assert.strictEqual(categorize('pandas.core.frame.DataFrame'), 'data');
    assert.strictEqual(categorize('pandas.core.series.Series'), 'data');
    assert.strictEqual(categorize('pandas.core.indexes.base.Index'), 'data');
    assert.strictEqual(categorize('polars.dataframe.frame.DataFrame'), 'data');
    assert.strictEqual(categorize('numpy.ndarray'), 'data');
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
    assert.strictEqual(typeHint('scipy.stats._kde.gaussian_kde', 0), 'gaussian_kde');
    assert.strictEqual(typeHint('numpy.int64', 245), 'int64 (245)');
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
