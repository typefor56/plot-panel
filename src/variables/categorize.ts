/**
 * Positron-style categorization of kernel variables, computed here — the
 * Jupyter extension returns a flat list. Pure module, no vscode import:
 * unit-tested against fixture arrays.
 *
 * The rule works on the fully-qualified Python type name and matches its last
 * dotted segment: table-like containers (pandas/polars/numpy) are DATA,
 * callables are FUNCTIONS, metaclass instances (class definitions) are
 * CLASSES, everything else is VALUES.
 */

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

const DATA_TYPES = new Set(['DataFrame', 'Series', 'Index', 'ndarray']);

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
  const name = DATA_TYPES.has(short) && root.length > 0 ? `${root}.${short}` : short;
  return indexedChildrenCount > 0 ? `${name} (${indexedChildrenCount})` : name;
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
