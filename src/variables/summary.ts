/**
 * Parser for the `summary` field that `jupyter.listVariables` attaches to
 * pandas DataFrames: the text produced by `df.info()`. Its per-column table
 * lists every column with its non-null count and dtype, which is enough to
 * expand a DataFrame into its columns even without the Kernels API (the
 * stable-VS Code path). Pure module, no vscode import.
 *
 * pandas omits the per-column table for very wide frames (more than
 * `display.max_info_columns`, 100 by default); the parser then reports
 * undefined and the row simply is not expandable.
 */

export interface DataFrameColumn {
  readonly name: string;
  readonly nonNull: string;
  readonly dtype: string;
}

// " 0   vru+line     444448 non-null  object" — the name is non-greedy up to
// the count so names containing spaces survive.
const COLUMN_LINE = /^\s*\d+\s+(.*?)\s+(\d[\d,]*)\s+non-null\s+(\S+)\s*$/;

export function parseDataFrameSummary(summary: string): readonly DataFrameColumn[] | undefined {
  if (!summary.includes('non-null')) {
    return undefined;
  }
  const columns: DataFrameColumn[] = [];
  for (const line of summary.split('\n')) {
    const match = COLUMN_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const [, name, count, dtype] = match;
    if (name !== undefined && count !== undefined && dtype !== undefined) {
      columns.push({ name: name.trim(), nonNull: `${count} non-null`, dtype });
    }
  }
  return columns.length > 0 ? columns : undefined;
}
