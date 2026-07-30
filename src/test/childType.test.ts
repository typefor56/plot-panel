import * as assert from 'assert';
import { canExpandRepr, inferChildType, qualifiedType } from '../variables/childType';
import {
  DF_LARGE,
  DF_SMALL,
  DICT_SMALL,
  LIST_SMALL,
  ND_1D,
  S_DATETIME,
  S_SMALL_NAMED,
  SET_SMALL,
  TUPLE_ONE,
} from './reprFixtures';

suite('Nested value type inference', () => {
  test('recognises the container forms from their repr', () => {
    assert.strictEqual(inferChildType(LIST_SMALL), 'list');
    assert.strictEqual(inferChildType(TUPLE_ONE), 'tuple');
    assert.strictEqual(inferChildType(SET_SMALL), 'set');
    assert.strictEqual(inferChildType(DICT_SMALL), 'dict');
    assert.strictEqual(inferChildType(ND_1D), 'ndarray');
  });

  test('recognises pandas objects', () => {
    assert.strictEqual(inferChildType(S_SMALL_NAMED), 'Series');
    assert.strictEqual(inferChildType(S_DATETIME), 'Series');
    assert.strictEqual(inferChildType(DF_SMALL), 'DataFrame');
    assert.strictEqual(inferChildType(DF_LARGE), 'DataFrame');
  });

  test('the shape tail alone identifies a truncated DataFrame', () => {
    // What survives of a frame nested in a list: SafeRepr caps inner items
    // at 128 characters, but the "[N rows x M columns]" tail is at the end.
    const truncated =
      '             a       b\n0            0       0\n1            1  ... 444447  444447\n\n[444448 rows x 2 columns]';
    assert.strictEqual(inferChildType(truncated), 'DataFrame');
  });

  test('scalars and unknown text are not containers', () => {
    for (const scalar of ['42', "'hello'", 'None', 'True', '3.14', '', '   ']) {
      assert.strictEqual(inferChildType(scalar), 'scalar', scalar);
    }
  });

  test('qualified names carry the package for the well-known types', () => {
    assert.strictEqual(qualifiedType('DataFrame'), 'pandas.DataFrame');
    assert.strictEqual(qualifiedType('Series'), 'pandas.Series');
    assert.strictEqual(qualifiedType('ndarray'), 'numpy.ndarray');
    assert.strictEqual(qualifiedType('list'), 'list');
    assert.strictEqual(qualifiedType('scalar'), '');
  });
});

suite('Expandability probe', () => {
  test('accepts what the parsers can turn into a table', () => {
    assert.strictEqual(canExpandRepr('pandas.Series', S_SMALL_NAMED, undefined), true);
    assert.strictEqual(canExpandRepr('list', LIST_SMALL, undefined), true);
    assert.strictEqual(canExpandRepr('dict', DICT_SMALL, undefined), true);
    assert.strictEqual(canExpandRepr('numpy.ndarray', ND_1D, undefined), true);
    assert.strictEqual(canExpandRepr('pandas.DataFrame', DF_SMALL, undefined), true);
  });

  test('a DataFrame is expandable from its df.info summary alone', () => {
    assert.strictEqual(canExpandRepr('pandas.DataFrame', '', 'anything'), true);
  });

  test('rejects scalars, empty reprs and unknown types', () => {
    assert.strictEqual(canExpandRepr('', '', undefined), false);
    assert.strictEqual(canExpandRepr('int', '42', undefined), false);
    assert.strictEqual(canExpandRepr('pandas.Series', 'not a series', undefined), false);
    assert.strictEqual(canExpandRepr('pandas.DataFrame', 'not a frame', undefined), false);
  });
});
