/**
 * Type inference for a nested value known only by its repr text.
 *
 * On stable VS Code the Variables view never gets a typed description of a
 * child — only the fragment of the parent's repr that stands for it. To keep
 * expanding past the first level we therefore have to recognise the shape of
 * that fragment. Pure module, no vscode import.
 *
 * Deliberately conservative, like the parsers it builds on: anything not
 * recognised is a scalar, which simply means "not expandable".
 *
 * Note the ceiling this works against, measured against real debugpy SafeRepr
 * output: nesting collapses to "..." past two levels and every nested item is
 * capped at 128 characters. A list of DataFrames still yields each frame's
 * "[N rows x M columns]" tail, but rarely a full grid — deeper, faithful
 * expansion is what a console session we own provides instead.
 */

import {
  type DataFrameGrid,
  parseCollectionRepr,
  parseDataFrameRepr,
  parseObjectRepr,
  parseSeriesRepr,
  parseWrappedColumns,
  splitDictItem,
} from './reprParse';
import { parseDataFrameSummary } from './summary';

export type InferredKind =
  | 'DataFrame'
  | 'Series'
  | 'list'
  | 'tuple'
  | 'set'
  | 'dict'
  | 'ndarray'
  | 'object'
  | 'scalar';

/** The pandas shape tail survives even a heavily truncated inner repr. */
const ROWS_X_COLUMNS = /\[\d[\d,]* rows x \d+ columns\]/;

const QUALIFIED: Readonly<Record<InferredKind, string>> = {
  DataFrame: 'pandas.DataFrame',
  Series: 'pandas.Series',
  ndarray: 'numpy.ndarray',
  list: 'list',
  tuple: 'tuple',
  set: 'set',
  dict: 'dict',
  object: 'object',
  scalar: '',
};

/** Fully-qualified type name for an inferred kind (''/scalar = unknown). */
export function qualifiedType(kind: InferredKind): string {
  return QUALIFIED[kind];
}

function usable(grid: DataFrameGrid | undefined): DataFrameGrid | undefined {
  return grid !== undefined && grid.columns.length > 0 && grid.rows.length > 0
    ? grid
    : undefined;
}

/**
 * Parse a frame's grid, tolerating the loss of its leading indentation.
 *
 * A DataFrame repr begins with a blank slot above the index column, and the
 * parser needs it to tell columns from indexes. A frame nested inside a
 * container loses it when the item is split out of the parent's repr, so
 * restore it before giving up rather than leave the row unexpandable.
 */
export function gridOf(text: string): DataFrameGrid | undefined {
  return usable(parseDataFrameRepr(text)) ?? usable(parseDataFrameRepr(`  ${text}`));
}

/** A grid with both a header and at least one data row. */
function hasGrid(text: string): boolean {
  return gridOf(text) !== undefined;
}

function braceKind(text: string): InferredKind {
  const parsed = parseCollectionRepr(text, 'dict');
  const first = parsed?.items[0];
  if (first === undefined) {
    return 'dict';
  }
  return splitDictItem(first) === undefined ? 'set' : 'dict';
}

/**
 * Best guess at what a repr fragment stands for. Order matters: the pandas
 * shape tail is checked first because it is unambiguous and survives
 * truncation, and the bracketed container forms are checked before the
 * grid parser, which is the most permissive.
 */
export function inferChildType(text: string): InferredKind {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return 'scalar';
  }
  if (ROWS_X_COLUMNS.test(trimmed)) {
    return 'DataFrame';
  }
  if (parseSeriesRepr(trimmed) !== undefined) {
    return 'Series';
  }
  if (trimmed.startsWith('array(')) {
    return 'ndarray';
  }
  if (trimmed.startsWith('[')) {
    return 'list';
  }
  if (trimmed.startsWith('(')) {
    return 'tuple';
  }
  if (trimmed.startsWith('{')) {
    return braceKind(trimmed);
  }
  // A frame prints a header line plus at least one row, so a single line can
  // never be one — and the grid parser is permissive enough to accept a bare
  // scalar as a header otherwise.
  if (trimmed.includes('\n') && hasGrid(trimmed)) {
    return 'DataFrame';
  }
  if (parseObjectRepr(trimmed) !== undefined) {
    return 'object';
  }
  return 'scalar';
}

/**
 * Whether a value of this type and repr would yield a preview table, without
 * building it. Used to decide a row's chevron: building the children instead
 * would recurse eagerly all the way down on every refresh.
 */
export function canExpandRepr(type: string, raw: string, summary: string | undefined): boolean {
  const dot = type.lastIndexOf('.');
  const short = dot === -1 ? type : type.slice(dot + 1);
  if (raw.length === 0 && summary === undefined) {
    return false;
  }
  switch (short) {
    case 'DataFrame':
      return (
        parseDataFrameSummary(summary ?? '') !== undefined ||
        gridOf(raw) !== undefined ||
        parseWrappedColumns(raw) !== undefined
      );
    case 'Series': {
      const parsed = parseSeriesRepr(raw);
      return parsed !== undefined && parsed.pairs.length > 0;
    }
    case 'list':
    case 'tuple':
    case 'set':
    case 'frozenset':
    case 'dict':
    case 'ndarray': {
      const parsed = parseCollectionRepr(raw, short);
      return parsed !== undefined && parsed.items.length > 0;
    }
    default:
      // Any other object still has a table in it when its repr names fields,
      // which is how matplotlib Axes and most library objects print.
      return parseObjectRepr(raw) !== undefined;
  }
}
