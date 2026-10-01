/**
 * Recursive expansion of variables described only by their repr.
 *
 * Every value we know how to look inside is a node in a registry. Asking for
 * a node's children parses its repr *then*, builds one preview row per child,
 * and registers each child as a node in turn — so the tree keeps opening for
 * as long as the repr still shows something, with no hard-coded depth.
 *
 * Node ids are synthetic (`<parent>#<index>`) rather than Python expressions,
 * because a Series label or a set element is expandable without being
 * addressable. The expression travels alongside and stays empty when indexing
 * would be a guess, which also withholds the Data Viewer button rather than
 * pointing it at the wrong data.
 *
 * Pure module, no vscode import: this is the part worth testing exhaustively,
 * since it is what the two-column preview tables are made of.
 */

import { dataViewerType, formatVariableValue, typeHint } from './categorize';
import { canExpandRepr, gridOf, inferChildType, qualifiedType } from './childType';
import {
  type DataFrameGrid,
  parseCollectionRepr,
  parseObjectRepr,
  parseSeriesRepr,
  parseWrappedColumns,
  splitDictItem,
} from './reprParse';
import { parseDataFrameSummary } from './summary';

export interface ExpandNode {
  readonly type: string;
  readonly raw: string;
  /** df.info() text; only ever attached to a top-level DataFrame. */
  readonly summary: string | undefined;
  /** Python eval path, '' when the value is not addressable. */
  readonly expression: string;
}

export interface PreviewRow {
  readonly name: string;
  /** Set on top-level rows whose value moved in the latest listing. */
  readonly changed?: boolean;
  readonly value: string;
  readonly typeHint: string;
  /** Fully qualified type, shown on hover when the hint is shortened or cut. */
  readonly fullType?: string;
  /** Size column of a top-level row ("100 × 3", "15"); children leave it out. */
  readonly size?: string;
  readonly expandable: boolean;
  readonly expression: string;
  readonly nodeId: string;
  readonly kind: 'variable' | 'ellipsis';
  readonly viewerType: string | undefined;
}

export const ELLIPSIS_ROW: PreviewRow = {
  name: '',
  value: '⋯',
  typeHint: '',
  expandable: false,
  expression: '',
  nodeId: '',
  kind: 'ellipsis',
  viewerType: undefined,
};

/** Longest value shown in a row before it is cut. */
export const VALUE_CAP = 80;

const INDEXED_TYPES = new Set(['list', 'tuple', 'set', 'frozenset', 'ndarray']);

export function truncate(value: string): string {
  return value.length > VALUE_CAP ? `${value.slice(0, VALUE_CAP - 1)}…` : value;
}

function shortType(type: string): string {
  const dot = type.lastIndexOf('.');
  return dot === -1 ? type : type.slice(dot + 1);
}

/**
 * Rebuild one column of a parsed grid as a Series repr, so "look inside a
 * column" and "look inside a Series" share a single code path. Empty cells
 * get a placeholder: the Series parser splits on runs of two spaces and would
 * otherwise reject the line, losing the whole table over one blank.
 */
function synthesizeSeries(
  grid: DataFrameGrid,
  column: number,
  dtype: string | undefined,
): string {
  const lines = grid.rows.map((row) => {
    const cell = row.cells[column];
    return `${row.index}  ${cell === undefined || cell.length === 0 ? 'NaN' : cell}`;
  });
  if (grid.gapAt !== undefined) {
    lines.splice(grid.gapAt, 0, '..');
  }
  lines.push(`dtype: ${dtype ?? 'object'}`);
  return lines.join('\n');
}

export class ExpandRegistry {
  private readonly nodes = new Map<string, ExpandNode>();
  private readonly cache = new Map<string, readonly PreviewRow[]>();

  clear(): void {
    this.nodes.clear();
    this.cache.clear();
  }

  /** Remember a value we may be asked to look inside; says whether we can. */
  register(nodeId: string, node: ExpandNode): boolean {
    this.nodes.set(nodeId, node);
    return canExpandRepr(node.type, node.raw, node.summary);
  }

  /** Children of a registered node, parsed once and memoized. */
  childrenOf(nodeId: string): readonly PreviewRow[] | undefined {
    const cached = this.cache.get(nodeId);
    if (cached !== undefined) {
      return cached;
    }
    const node = this.nodes.get(nodeId);
    if (node === undefined) {
      return undefined;
    }
    const short = shortType(node.type);
    let rows: readonly PreviewRow[] | undefined;
    if (short === 'DataFrame') {
      rows = this.dataFrameChildren(nodeId, node);
    } else if (short === 'Series') {
      rows = this.seriesChildren(nodeId, node);
    } else if (short === 'dict') {
      rows = this.dictChildren(nodeId, node);
    } else if (INDEXED_TYPES.has(short)) {
      rows = this.itemChildren(nodeId, node, short);
    } else {
      rows = this.objectChildren(nodeId, node);
    }
    if (rows !== undefined) {
      this.cache.set(nodeId, rows);
    }
    return rows;
  }

  /**
   * One row for a nested value, typed by inference from its own repr and
   * registered as a node so it can be expanded in turn.
   */
  private nestedRow(
    parentId: string,
    position: number,
    name: string,
    raw: string,
    expression: string,
  ): PreviewRow {
    const nodeId = `${parentId}#${position}`;
    const type = qualifiedType(inferChildType(raw));
    const expandable = this.register(nodeId, {
      type,
      raw,
      summary: undefined,
      expression,
    });
    return {
      name,
      value: truncate(
        type.length > 0 ? formatVariableValue(type, raw) : raw.replace(/\s+/g, ' ').trim(),
      ),
      typeHint: type.length > 0 ? typeHint(type, 0) : '',
      expandable,
      expression,
      nodeId,
      kind: 'variable',
      viewerType: expression.length > 0 ? dataViewerType(type) : undefined,
    };
  }

  /**
   * A DataFrame lists its columns: names and non-null counts from df.info()
   * when Jupyter attached it, otherwise from the repr grid alone — which is
   * the case for a frame nested inside another value.
   */
  private dataFrameChildren(nodeId: string, node: ExpandNode): readonly PreviewRow[] | undefined {
    const columns = node.summary !== undefined ? parseDataFrameSummary(node.summary) : undefined;
    const grid = gridOf(node.raw);
    // A frame too wide to print in one block has neither a df.info() column
    // table (pandas stops at 100 columns) nor a placeable grid, but its
    // wrapped header still names the columns — enough to list them and open
    // each in the data viewer.
    const names =
      columns?.map((column) => column.name) ?? grid?.columns ?? parseWrappedColumns(node.raw);
    if (names === undefined) {
      return undefined;
    }
    const rows: PreviewRow[] = [];
    names.forEach((name, position) => {
      // pandas prints a literal "..." column past its display limit.
      if (name === '...') {
        return;
      }
      const info = columns?.[position];
      const childId = `${nodeId}#${position}`;
      const expression =
        node.expression.length > 0 ? `${node.expression}[${JSON.stringify(name)}]` : '';
      const gridIndex = grid?.columns.indexOf(name) ?? -1;
      const raw =
        grid !== undefined && gridIndex !== -1 ? synthesizeSeries(grid, gridIndex, info?.dtype) : '';
      const expandable = this.register(childId, {
        type: 'pandas.Series',
        raw,
        summary: undefined,
        expression,
      });
      rows.push({
        name,
        value: info?.nonNull ?? truncate(formatVariableValue('pandas.Series', raw)),
        typeHint: info?.dtype ?? 'pandas.Series',
        expandable,
        expression,
        nodeId: childId,
        kind: 'variable',
        // A DataFrame column evaluates to a Series; the viewer accepts the
        // expression as its name and resolves it in the kernel.
        viewerType: expression.length > 0 ? 'Series' : undefined,
      });
    });
    return rows.length > 0 ? rows : undefined;
  }

  /**
   * Objects that name their fields in their repr — matplotlib Axes and most
   * library objects — are already a two-column table.
   */
  private objectChildren(nodeId: string, node: ExpandNode): readonly PreviewRow[] | undefined {
    const parsed = parseObjectRepr(node.raw);
    if (parsed === undefined) {
      return undefined;
    }
    return parsed.fields.map(([key, value], position) =>
      this.nestedRow(nodeId, position, key, value, ''),
    );
  }

  private seriesChildren(nodeId: string, node: ExpandNode): readonly PreviewRow[] | undefined {
    const parsed = parseSeriesRepr(node.raw);
    if (parsed === undefined || parsed.pairs.length === 0) {
      return undefined;
    }
    // No expression for a label: an index is not reliably addressable
    // (integer labels, datetimes, duplicates) and a wrong one would open the
    // wrong data in the viewer.
    const rows: PreviewRow[] = parsed.pairs.map(([index, value], position) =>
      this.nestedRow(nodeId, position, index, value, ''),
    );
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
  }

  private dictChildren(nodeId: string, node: ExpandNode): readonly PreviewRow[] | undefined {
    const parsed = parseCollectionRepr(node.raw, 'dict');
    if (parsed === undefined || parsed.items.length === 0) {
      return undefined;
    }
    const rows: PreviewRow[] = parsed.items.map((item, position) => {
      const split = splitDictItem(item);
      if (split === undefined) {
        return this.nestedRow(nodeId, position, String(position), item, '');
      }
      // The parsed key is already a Python literal, so d[<key>] is valid.
      const expression = node.expression.length > 0 ? `${node.expression}[${split[0]}]` : '';
      return this.nestedRow(nodeId, position, split[0], split[1], expression);
    });
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
  }

  private itemChildren(
    nodeId: string,
    node: ExpandNode,
    short: string,
  ): readonly PreviewRow[] | undefined {
    const parsed = parseCollectionRepr(node.raw, short);
    if (parsed === undefined || parsed.items.length === 0) {
      return undefined;
    }
    const unordered = short === 'set' || short === 'frozenset';
    const rows: PreviewRow[] = parsed.items.map((item, position) => {
      // Positions after a mid-repr gap (numpy) are unknown: leave them blank.
      const known = parsed.gapAt === undefined || position < parsed.gapAt;
      const addressable = known && !unordered && node.expression.length > 0;
      return this.nestedRow(
        nodeId,
        position,
        known && !unordered ? String(position) : '',
        item,
        addressable ? `${node.expression}[${position}]` : '',
      );
    });
    if (parsed.gapAt !== undefined) {
      rows.splice(parsed.gapAt, 0, ELLIPSIS_ROW);
    }
    return rows;
  }
}
