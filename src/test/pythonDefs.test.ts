import * as assert from 'assert';
import { parsePythonDefinitions } from '../variables/pythonDefs';

suite('Python definition extraction', () => {
  test('picks up module-level functions and classes with their signatures', () => {
    const defs = parsePythonDefinitions(
      [
        'import pandas as pd',
        '',
        'def plot_calls(df, ax=None):',
        '    return ax',
        '',
        'async def fetch(url: str) -> bytes:',
        '    ...',
        '',
        'class Report(Base):',
        '    pass',
        '',
        'class Plain:',
        '    pass',
      ].join('\n'),
    );
    assert.deepStrictEqual(defs, [
      { kind: 'function', name: 'plot_calls', signature: '(df, ax=None)' },
      { kind: 'function', name: 'fetch', signature: '(url: str)' },
      { kind: 'class', name: 'Report', signature: '(Base)' },
      { kind: 'class', name: 'Plain', signature: '' },
    ]);
  });

  test('joins a signature spread over several lines', () => {
    const defs = parsePythonDefinitions(
      ['def wide(', '    first,', '    second=(1, 2),', '):', '    pass'].join('\n'),
    );
    assert.deepStrictEqual(defs, [
      { kind: 'function', name: 'wide', signature: '( first, second=(1, 2), )' },
    ]);
  });

  test('ignores nested definitions and decorators', () => {
    const defs = parsePythonDefinitions(
      [
        '@decorator',
        'def outer():',
        '    def inner():',
        '        pass',
        '    class Nested:',
        '        pass',
        '    return inner',
      ].join('\n'),
    );
    assert.deepStrictEqual(defs.map((def) => def.name), ['outer']);
  });

  test('ignores code shown inside a docstring', () => {
    const defs = parsePythonDefinitions(
      ['"""Example:', '', 'def not_real():', '    pass', '"""', '', 'def real():', '    pass'].join(
        '\n',
      ),
    );
    assert.deepStrictEqual(defs.map((def) => def.name), ['real']);
  });

  test('a redefinition updates in place rather than duplicating', () => {
    const defs = parsePythonDefinitions(
      ['def f(a):', '    pass', '', 'def g():', '    pass', '', 'def f(a, b):', '    pass'].join(
        '\n',
      ),
    );
    assert.deepStrictEqual(defs, [
      { kind: 'function', name: 'f', signature: '(a, b)' },
      { kind: 'function', name: 'g', signature: '()' },
    ]);
  });

  test('parentheses inside strings and comments do not end the signature', () => {
    const defs = parsePythonDefinitions(['def f(sep=") #", other=1):', '    pass'].join('\n'));
    assert.deepStrictEqual(defs, [
      { kind: 'function', name: 'f', signature: '(sep=") #", other=1)' },
    ]);
  });

  test('source without definitions yields nothing', () => {
    assert.deepStrictEqual(parsePythonDefinitions('x = 1\nprint(x)\n'), []);
  });
});
