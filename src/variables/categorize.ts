/**
 * Positron-style categorization of kernel variables, computed here — the
 * Jupyter extension returns a flat list. Pure module, no vscode import:
 * unit-tested against fixture arrays.
 *
 * The rule works on the fully-qualified Python type name and matches its last
 * dotted segment: pandas/polars tables (DataFrame, Series, Index) are DATA,
 * callables are FUNCTIONS, metaclass instances (class definitions) are
 * CLASSES, everything else — numpy arrays included, as in Positron — is
 * VALUES. Note that `jupyter.listVariables` excludes functions, classes and
 * modules kernel-side, so those sections only fill from richer sources.
 */

import { elideItems, parseCollectionRepr, parseSeriesRepr } from './reprParse';

export type VariableCategory = 'data' | 'values' | 'functions' | 'classes';

export const CATEGORY_ORDER: readonly VariableCategory[] = [
  'data',
  'values',
  'functions',
  'classes',
];

export const CATEGORY_LABELS: Readonly<Record<VariableCategory, string>> = {
  data: 'DATA',
  values: 'VALUES',
  functions: 'FUNCTIONS',
  classes: 'CLASSES',
};

const DATA_TYPES = new Set(['DataFrame', 'Series', 'Index']);

/** Types whose hint keeps the root package ("pandas.DataFrame", "numpy.ndarray"). */
const PREFIXED_TYPES = new Set(['DataFrame', 'Series', 'Index', 'ndarray']);

const FUNCTION_TYPES = new Set([
  'function',
  'builtin_function_or_method',
  'method',
  'method-wrapper',
  'method_descriptor',
  'ufunc',
  'cython_function_or_method',
  'partial',
]);

const CLASS_TYPES = new Set(['type', 'ABCMeta']);

function lastSegment(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot === -1 ? type : type.slice(dot + 1);
}

export function categorize(type: string): VariableCategory {
  const short = lastSegment(type);
  if (DATA_TYPES.has(short)) {
    return 'data';
  }
  if (FUNCTION_TYPES.has(short)) {
    return 'functions';
  }
  if (CLASS_TYPES.has(short) || short.endsWith('Meta') || short.toLowerCase().endsWith('metaclass')) {
    return 'classes';
  }
  return 'values';
}

/**
 * Right-aligned type hint for a row: the short type name, prefixed by its
 * root package for the well-known table types ("pandas.DataFrame"), with an
 * element count for indexed containers ("list (12)").
 */
export function typeHint(type: string, indexedChildrenCount: number): string {
  const short = lastSegment(type);
  const root = type.includes('.') ? type.slice(0, type.indexOf('.')) : '';
  const name = PREFIXED_TYPES.has(short) && root.length > 0 ? `${root}.${short}` : short;
  return indexedChildrenCount > 0 ? `${name} (${indexedChildrenCount})` : name;
}

const ROWS_X_COLUMNS = /\[(\d[\d,]*) rows x (\d+) columns\]/;

/** Character budget for elided item previews in the value column. */
const ELIDE_BUDGET = 60;

const COLLECTION_BRACKETS: Readonly<Record<string, readonly [string, string]>> = {
  list: ['[', ']'],
  ndarray: ['[', ']'],
  tuple: ['(', ')'],
  set: ['{', '}'],
  frozenset: ['{', '}'],
  dict: ['{', '}'],
};

/**
 * Positron-style value column, always one line and two visual columns:
 * - DataFrame → only its shape, "[N rows x M columns]" (the type hint on the
 *   right already names the type);
 * - Series → an elided preview of its values, "[5, 7, 2, …, 9, 1]";
 * - list/tuple/set/dict/ndarray → elided items with their own brackets;
 * - everything else → the repr with whitespace collapsed.
 */
export function formatVariableValue(type: string, raw: string): string {
  const short = lastSegment(type);
  if (short === 'DataFrame') {
    const match = ROWS_X_COLUMNS.exec(raw);
    if (match !== null) {
      return match[0];
    }
  }
  if (short === 'Series') {
    const parsed = parseSeriesRepr(raw);
    if (parsed !== undefined) {
      const values = parsed.pairs.map((pair) => pair[1]);
      return `[${elideItems(values, parsed.gapAt, ELIDE_BUDGET)}]`;
    }
  }
  const brackets = COLLECTION_BRACKETS[short];
  if (brackets !== undefined) {
    const parsed = parseCollectionRepr(raw, short);
    if (parsed !== undefined) {
      return `${brackets[0]}${elideItems(parsed.items, parsed.gapAt, ELIDE_BUDGET)}${brackets[1]}`;
    }
  }
  let value = raw.replace(/\s+/g, ' ').trim();
  if (short === 'ndarray' && value.startsWith('array(')) {
    value = value.slice('array('.length);
    if (value.endsWith(')')) {
      value = value.slice(0, -1);
    }
  }
  return value;
}

/**
 * Element count of a variable, from the only sources the stable data path
 * offers: the DataFrame shape tail, the Series Length tail, Jupyter's count
 * (list/tuple/set only), or a completely-shown collection repr. 0 = unknown.
 */
export function variableSize(type: string, raw: string, indexedChildrenCount: number): number {
  const short = lastSegment(type);
  if (short === 'DataFrame') {
    const match = ROWS_X_COLUMNS.exec(raw);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return Number.parseInt(match[1].replace(/,/g, ''), 10) * Number.parseInt(match[2], 10);
    }
    return 0;
  }
  if (short === 'Series') {
    return parseSeriesRepr(raw)?.length ?? 0;
  }
  if (indexedChildrenCount > 0) {
    return indexedChildrenCount;
  }
  if (short === 'str') {
    // The repr carries the quotes; good enough for size bucketing.
    return Math.max(raw.length - 2, 0);
  }
  if (COLLECTION_BRACKETS[short] !== undefined) {
    const parsed = parseCollectionRepr(raw, short);
    if (parsed !== undefined && parsed.gapAt === undefined) {
      return parsed.items.length;
    }
  }
  return 0;
}

/** Count shown in the type hint ("list (1000)"); 0 = omit. Strings and
 *  DataFrames stay bare — their size is visible in the value column. */
export function variableCount(type: string, raw: string, indexedChildrenCount: number): number {
  const short = lastSegment(type);
  if (short === 'DataFrame' || short === 'str') {
    return 0;
  }
  return variableSize(type, raw, indexedChildrenCount);
}

const DATA_VIEWER_TYPES = new Set([
  'DataFrame',
  'Series',
  'ndarray',
  'list',
  'dict',
  'Tensor',
  'EagerTensor',
  'DataArray',
]);

/**
 * The `type` value the Jupyter data-viewer delegation understands (it must
 * be an exact member of the viewers' contributed dataTypes), or undefined
 * when the variable cannot be opened in a viewer.
 */
export function dataViewerType(type: string): string | undefined {
  const short = lastSegment(type);
  return DATA_VIEWER_TYPES.has(short) ? short : undefined;
}

/**
 * Group by category in the fixed section order (empty categories omitted),
 * each group sorted by name, case-insensitive.
 */
export function groupAndSort<T extends { readonly name: string; readonly type: string }>(
  variables: readonly T[],
): ReadonlyMap<VariableCategory, readonly T[]> {
  const buckets = new Map<VariableCategory, T[]>();
  for (const variable of variables) {
    const category = categorize(variable.type);
    const bucket = buckets.get(category);
    if (bucket === undefined) {
      buckets.set(category, [variable]);
    } else {
      bucket.push(variable);
    }
  }
  const result = new Map<VariableCategory, readonly T[]>();
  for (const category of CATEGORY_ORDER) {
    const bucket = buckets.get(category);
    if (bucket !== undefined) {
      bucket.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      result.set(category, bucket);
    }
  }
  return result;
}
