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

import { elideItems, ndarrayShape, parseCollectionRepr, parseSeriesRepr } from './reprParse';

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

/**
 * R class names, matched whole. They must not go through the last-segment
 * rule: "data.frame" is one name, not a module path ending in "frame".
 */
const R_DATA_TYPES = new Set(['data.frame', 'tbl_df', 'data.table', 'matrix', 'array']);

/** Types whose hint keeps the root package, abbreviated as the ecosystem
 *  writes it ("np.ndarray"): the hint column is narrow and the element count
 *  beside it matters more than the full package name. */
const PREFIXED_TYPES = new Set(['DataFrame', 'Series', 'Index', 'ndarray']);

const PACKAGE_ALIAS: Readonly<Record<string, string>> = {
  numpy: 'np',
  pandas: 'pd',
  polars: 'pl',
};

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

// 'class' is not a Python type name; it is the marker the view uses for
// definitions recovered from cell source, where there is no live object.
const CLASS_TYPES = new Set(['type', 'ABCMeta', 'class']);

function lastSegment(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot === -1 ? type : type.slice(dot + 1);
}

export function categorize(type: string): VariableCategory {
  if (R_DATA_TYPES.has(type)) {
    return 'data';
  }
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
  if (R_DATA_TYPES.has(type)) {
    return type;
  }
  const short = lastSegment(type);
  const root = type.includes('.') ? type.slice(0, type.indexOf('.')) : '';
  const alias = PACKAGE_ALIAS[root] ?? root;
  // numpy scalars keep their package too: "np.int64", not a bare "int64".
  const prefixed = PREFIXED_TYPES.has(short) || (root === 'numpy' && NUMPY_SCALAR.test(short));
  const name = prefixed && alias.length > 0 ? `${alias}.${short}` : short;
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
  return unwrapNumpyScalars(formatRaw(type, raw));
}

/**
 * numpy 2 reprs its scalars as "np.int64(8)"; the type column already says
 * np.int64, so the value column keeps just the number — in lists and
 * previews too ("[np.float64(3.2), …]" → "[3.2, …]").
 */
const NUMPY_SCALAR_REPR =
  /\b(?:np|numpy)\.(?:u?int\d*|float\d*|complex\d*|bool_?|str_|bytes_|longdouble|clongdouble|datetime64|timedelta64)\(([^()]*)\)/g;

function unwrapNumpyScalars(value: string): string {
  return value.replace(NUMPY_SCALAR_REPR, '$1');
}

function formatRaw(type: string, raw: string): string {
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

/** Python scalars, whose value is short and is the whole point. */
const CONSTANT_TYPES = new Set([
  'int',
  'float',
  'complex',
  'bool',
  'str',
  'bytes',
  'NoneType',
  'Decimal',
  'Fraction',
]);
/** numpy scalars (np.float64, np.int32, np.bool_…), matched on the last segment. */
const NUMPY_SCALAR = /^(u?int\d*|float\d*|complex\d*|bool_?|str_|bytes_|datetime64|timedelta64)$/;
/** R atomic vectors: a constant only at length 1. */
const R_ATOMIC_TYPES = new Set(['numeric', 'integer', 'double', 'character', 'logical', 'complex']);

/**
 * Whether the value column shows this variable's value. Only constants do:
 * for a container the value is a truncated preview nobody reads — its type
 * and size say more, and the Data Viewer or the expansion shows the content.
 */
export function isConstant(type: string, size: number): boolean {
  if (R_ATOMIC_TYPES.has(type)) {
    return size <= 1;
  }
  const short = lastSegment(type);
  return CONSTANT_TYPES.has(short) || NUMPY_SCALAR.test(short);
}

/** df.info(): "RangeIndex: 100 entries, 0 to 99" … "Data columns (total 3 columns):". */
const INFO_ROWS = /(\d[\d,]*) entries/;
// Past 100 columns pandas drops the table and writes "Columns: 150 entries, a to z".
const INFO_COLUMNS = /total (\d[\d,]*) columns|Columns: (\d[\d,]*) entries/;

/**
 * Size column. Arrays and tables use numpy's shape notation — "(10,)",
 * "(100, 100)", "(2, 3, 10)" — since a count alone hides the dimensions;
 * other containers show their length; constants nothing ('' = unknown).
 */
export function sizeLabel(
  type: string,
  raw: string,
  indexedChildrenCount: number,
  summary?: string,
): string {
  const short = lastSegment(type);
  if (short === 'ndarray') {
    return (
      ndarrayShape(raw, indexedChildrenCount) ??
      (indexedChildrenCount > 0 ? `(${indexedChildrenCount},)` : '')
    );
  }
  if (short === 'DataFrame') {
    const match = ROWS_X_COLUMNS.exec(raw);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      return `(${match[1].replace(/,/g, '')}, ${match[2]})`;
    }
    const rows = summary === undefined ? undefined : INFO_ROWS.exec(summary)?.[1];
    const columnMatch = summary === undefined ? null : INFO_COLUMNS.exec(summary);
    const columns = columnMatch?.[1] ?? columnMatch?.[2];
    return rows !== undefined && columns !== undefined
      ? `(${rows.replace(/,/g, '')}, ${columns.replace(/,/g, '')})`
      : '';
  }
  if (isConstant(type, 0) && short !== 'str') {
    return '';
  }
  const size = variableSize(type, raw, indexedChildrenCount);
  if (size === 0) {
    return '';
  }
  return short === 'Series' ? `(${size},)` : String(size);
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

export type VariablesGrouping = 'kind' | 'size';
export type VariablesSorting = 'name' | 'size' | 'recent';

export interface OrganizedSection<T> {
  readonly label: string;
  readonly rows: readonly T[];
}

interface Organizable {
  readonly name: string;
  readonly type: string;
  /** Element count; 0 = unknown (see variableSize). */
  readonly size: number;
  /** Session timestamp of the last observed change; 0 = never observed. */
  readonly changedAt: number;
}

const SIZE_LARGE = 100_000;
const SIZE_MEDIUM = 1_000;

function comparatorFor<T extends Organizable>(sorting: VariablesSorting): (a: T, b: T) => number {
  const byName = (a: T, b: T): number =>
    a.name.toLowerCase().localeCompare(b.name.toLowerCase());
  switch (sorting) {
    case 'name':
      return byName;
    case 'size':
      return (a, b) => b.size - a.size || byName(a, b);
    case 'recent':
      return (a, b) => b.changedAt - a.changedAt || byName(a, b);
  }
}

/**
 * Group into ordered sections (empty ones omitted) and sort within each.
 * 'kind' = the Positron categories; 'size' = LARGE (≥100k elements) /
 * MEDIUM (≥1k) / SMALL magnitude buckets. Sorting applies within sections
 * under both groupings.
 */
export function organizeVariables<T extends Organizable>(
  variables: readonly T[],
  grouping: VariablesGrouping,
  sorting: VariablesSorting,
): readonly OrganizedSection<T>[] {
  const compare = comparatorFor<T>(sorting);
  const sections: OrganizedSection<T>[] = [];
  if (grouping === 'size') {
    const buckets: readonly (readonly [string, (variable: T) => boolean])[] = [
      ['LARGE', (variable) => variable.size >= SIZE_LARGE],
      ['MEDIUM', (variable) => variable.size >= SIZE_MEDIUM && variable.size < SIZE_LARGE],
      ['SMALL', (variable) => variable.size < SIZE_MEDIUM],
    ];
    for (const [label, matches] of buckets) {
      const rows = variables.filter(matches).sort(compare);
      if (rows.length > 0) {
        sections.push({ label, rows });
      }
    }
    return sections;
  }
  for (const category of CATEGORY_ORDER) {
    const rows = variables
      .filter((variable) => categorize(variable.type) === category)
      .sort(compare);
    if (rows.length > 0) {
      sections.push({ label: CATEGORY_LABELS[category], rows });
    }
  }
  return sections;
}
