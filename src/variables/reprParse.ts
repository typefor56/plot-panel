/**
 * Parsers over the SafeRepr strings that `jupyter.listVariables` returns as
 * variable values. They power the stable-VS Code tier of the Variables view:
 * without the (publisher-gated) Kernels API there is no way to ask the kernel
 * for a variable's items, but the repr already shows a head/tail preview —
 * pandas Series and DataFrames print aligned index/value grids, collections
 * print their items. Pure module, no vscode import, fixture-tested against
 * real pandas + SafeRepr output (src/test/reprFixtures.ts).
 *
 * All parsers are deliberately pessimistic: anything that does not look
 * exactly like the expected shape returns undefined and the caller falls
 * back to a flat, non-expandable presentation. A wrong table would be worse
 * than none.
 */

export interface SeriesRepr {
  /** [index, value] pairs, in repr order. */
  readonly pairs: readonly (readonly [string, string])[];
  /** Insertion position of the pandas truncation row within pairs. */
  readonly gapAt: number | undefined;
  /** From the "Length: N" tail, or pairs.length for a complete repr. */
  readonly length: number | undefined;
  readonly dtype: string | undefined;
}

export interface DataFrameGrid {
  readonly columns: readonly string[];
  readonly rows: readonly { readonly index: string; readonly cells: readonly string[] }[];
  /** Insertion position of the pandas truncation row within rows. */
  readonly gapAt: number | undefined;
}

export interface CollectionItems {
  readonly items: readonly string[];
  /**
   * Insertion position of a "..." truncation marker within items (trailing
   * for SafeRepr-cut collections, middle for numpy's summarized arrays).
   */
  readonly gapAt: number | undefined;
}

/** A line made only of dots — pandas' truncation row. */
const GAP_LINE = /^\s*\.{2,}\s*$/;
const ROWS_X_COLUMNS_LINE = /^\[\d[\d,]* rows x \d+ columns\]$/;
const TWO_SPACES = /\s{2,}/g;

/** Split at the LAST run of >= 2 spaces (values are right-aligned; indexes
 *  may contain single spaces, e.g. datetimes "2021-01-01 00:00:01"). */
function splitAtLastGap(line: string): readonly [string, string] | undefined {
  let splitStart = -1;
  let splitEnd = -1;
  TWO_SPACES.lastIndex = 0;
  for (let match = TWO_SPACES.exec(line); match !== null; match = TWO_SPACES.exec(line)) {
    if (match.index > 0 && match.index + match[0].length < line.length) {
      splitStart = match.index;
      splitEnd = match.index + match[0].length;
    }
  }
  if (splitStart === -1) {
    return undefined;
  }
  return [line.slice(0, splitStart).trim(), line.slice(splitEnd).trim()];
}

export function parseSeriesRepr(raw: string): SeriesRepr | undefined {
  const lines = raw.split('\n').filter((line) => line.trim().length > 0);
  const last = lines.at(-1);
  if (last === undefined) {
    return undefined;
  }
  // Empty series: "Series([], dtype: object)".
  const empty = /^Series\(\[\],\s*dtype:\s*(\S+?)\)?$/.exec(last.trim());
  if (empty !== undefined && empty !== null && lines.length === 1) {
    return { pairs: [], gapAt: undefined, length: 0, dtype: empty[1] };
  }
  // Every pandas Series repr ends with a metadata line carrying "dtype:";
  // its absence means this is not a Series repr (or the tail was cut).
  if (!last.includes('dtype:')) {
    return undefined;
  }
  const lengthMatch = /Length:\s*(\d+)/.exec(last);
  const dtypeMatch = /dtype:\s*(\S+)/.exec(last);
  const pairs: [string, string][] = [];
  let gapAt: number | undefined;
  for (const line of lines.slice(0, -1)) {
    if (GAP_LINE.test(line)) {
      gapAt = gapAt ?? pairs.length;
      continue;
    }
    const pair = splitAtLastGap(line.trimEnd());
    if (pair === undefined) {
      // Not an index/value line: bail rather than produce a wrong table.
      return undefined;
    }
    pairs.push([pair[0], pair[1]]);
  }
  const parsedLength =
    lengthMatch?.[1] !== undefined
      ? Number.parseInt(lengthMatch[1], 10)
      : gapAt === undefined
        ? pairs.length
        : undefined;
  return {
    pairs,
    gapAt,
    length: parsedLength,
    dtype: dtypeMatch?.[1],
  };
}

export function parseDataFrameRepr(raw: string): DataFrameGrid | undefined {
  const allLines = raw.split('\n');
  const lines: string[] = [];
  for (const line of allLines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.endsWith('\\')) {
      // Width-wrapped repr (column blocks): positions are unrecoverable.
      return undefined;
    }
    if (ROWS_X_COLUMNS_LINE.test(trimmed.trim())) {
      continue; // shape tail
    }
    lines.push(trimmed);
  }
  const header = lines[0];
  if (header === undefined || header.startsWith('Empty DataFrame')) {
    return undefined;
  }
  const headerTokens = header.split(TWO_SPACES);
  if (headerTokens[0] === '') {
    headerTokens.shift(); // blank slot above the index column
  }
  if (headerTokens.length === 0 || headerTokens.some((token) => token.trim().length === 0)) {
    return undefined;
  }
  const columns = headerTokens.map((token) => token.trim());
  const rows: { index: string; cells: string[] }[] = [];
  let gapAt: number | undefined;
  for (const line of lines.slice(1)) {
    const tokens = line.split(TWO_SPACES).map((token) => token.trim());
    const first = tokens[0];
    if (first !== undefined && /^\.{2,}$/.test(first)) {
      gapAt = gapAt ?? rows.length;
      continue;
    }
    if (first === '' || tokens.length !== columns.length + 1) {
      // MultiIndex continuation line, second header line (MultiIndex
      // columns) or a mid-grid SafeRepr cut: a wrong grid is worse than none.
      return undefined;
    }
    const [index, ...cells] = tokens;
    if (index === undefined) {
      return undefined;
    }
    rows.push({ index, cells });
  }
  return { columns, rows, gapAt };
}

interface Wrapper {
  readonly open: string;
  readonly close: string;
}

function wrapperFor(shortType: string): Wrapper | undefined {
  switch (shortType) {
    case 'list':
    case 'ndarray':
      return { open: '[', close: ']' };
    case 'tuple':
      return { open: '(', close: ')' };
    case 'set':
    case 'frozenset':
    case 'dict':
      return { open: '{', close: '}' };
    default:
      return undefined;
  }
}

/** Iterate `content` splitting on top-level commas (bracket depth + quotes). */
function splitTopLevel(content: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | undefined;
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content[i];
    if (quote !== undefined) {
      if (char === '\\') {
        i++; // skip the escaped character
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '[' || char === '(' || char === '{') {
      depth++;
    } else if (char === ']' || char === ')' || char === '}') {
      depth--;
    } else if (depth === 0 && char === separator) {
      parts.push(content.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(content.slice(start));
  return parts;
}

export function parseCollectionRepr(raw: string, type: string): CollectionItems | undefined {
  const shortType = type.slice(type.lastIndexOf('.') + 1);
  const wrapper = wrapperFor(shortType);
  if (wrapper === undefined) {
    return undefined;
  }
  const text = raw.trim();
  const open = text.indexOf(wrapper.open);
  if (open === -1) {
    return undefined; // e.g. a 0-d ndarray: array(5.0)
  }
  // Matching-bracket scan so ndarray suffixes (", dtype=int8)") are ignored.
  let depth = 0;
  let quote: string | undefined;
  let close = -1;
  for (let i = open; i < text.length; i++) {
    const char = text[i];
    if (quote !== undefined) {
      if (char === '\\') {
        i++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
    } else if (char === wrapper.open) {
      depth++;
    } else if (char === wrapper.close) {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1) {
    return undefined;
  }
  const content = text.slice(open + 1, close);
  const items: string[] = [];
  let gapAt: number | undefined;
  for (const part of splitTopLevel(content, ',')) {
    const item = part.replace(/\s+/g, ' ').trim();
    if (item.length === 0) {
      continue; // "(1,)" trailing slot, empty wrappers
    }
    if (item === '...' || item === '…') {
      gapAt = gapAt ?? items.length;
      continue;
    }
    items.push(item);
  }
  return { items, gapAt };
}

/** "key: value" split at the first top-level colon (dict item from repr). */
export function splitDictItem(item: string): readonly [string, string] | undefined {
  const parts = splitTopLevel(item, ':');
  const key = parts[0];
  if (parts.length < 2 || key === undefined) {
    return undefined;
  }
  return [key.trim(), parts.slice(1).join(':').trim()];
}

/**
 * Head + tail preview within a character budget: "5, 7, 2, …, 9, 1".
 * When gapAt is defined, head items only come from before the gap and tail
 * items from after it, so the preview never fabricates adjacency.
 */
export function elideItems(
  items: readonly string[],
  gapAt: number | undefined,
  budget: number,
): string {
  const separatorCost = 2; // ", "
  if (gapAt === undefined) {
    const whole = items.join(', ');
    if (whole.length <= budget) {
      return whole;
    }
  }
  const headLimit = gapAt ?? items.length;
  const head: string[] = [];
  let used = 1; // the ellipsis
  // Keep the head under ~60% of the budget so the tail stays visible too.
  const headBudget = Math.ceil(budget * 0.6);
  for (const item of items.slice(0, headLimit)) {
    if (used + item.length + separatorCost > headBudget) {
      break;
    }
    head.push(item);
    used += item.length + separatorCost;
  }
  const tail: string[] = [];
  const tailFloor = Math.max(headLimit === items.length ? head.length : headLimit, head.length);
  for (let i = items.length - 1; i >= tailFloor; i--) {
    const item = items[i];
    if (item === undefined || used + item.length + separatorCost > budget) {
      break;
    }
    tail.unshift(item);
    used += item.length + separatorCost;
  }
  if (head.length + tail.length === items.length && gapAt === undefined) {
    return items.join(', ');
  }
  return [...head, '…', ...tail].join(', ');
}
