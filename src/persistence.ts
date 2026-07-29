import * as vscode from 'vscode';
import { contentId } from './hash';
import type { PlotHistory } from './history';
import { extensionForMime } from './mime';
import type { PlotEntry, PlotSourceKind } from './types';

/**
 * Persistence of the plot history across restarts, in the extension's global
 * storage directory (never workspaceState, which is not meant for binary
 * data). Layout: one image file per entry, content-addressed by its id, plus
 * an index.json with the metadata and the current selection.
 *
 * Writes are serialized through a promise queue and each sync is a full,
 * idempotent reconciliation of the directory against a history snapshot, so
 * crashes can at worst lose the latest figures, never corrupt the store.
 */

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;

interface IndexRecord {
  readonly id: string;
  readonly mime: string;
  readonly timestamp: number;
  readonly source: string;
  readonly sourceKind: PlotSourceKind;
  readonly file: string;
}

interface IndexFile {
  readonly version: number;
  readonly selectedId: string | undefined;
  readonly records: readonly IndexRecord[];
}

interface Snapshot {
  readonly entries: readonly PlotEntry[];
  readonly selectedId: string | undefined;
}

function fileNameFor(entry: { id: string; mime: string }): string {
  return `${entry.id}.${extensionForMime(entry.mime)}`;
}

function isRecord(value: unknown): value is IndexRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Partial<IndexRecord>;
  return (
    typeof record.id === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.timestamp === 'number' &&
    typeof record.source === 'string' &&
    (record.sourceKind === 'notebook' || record.sourceKind === 'interactive') &&
    typeof record.file === 'string' &&
    !record.file.includes('/') &&
    !record.file.includes('\\')
  );
}

export class PlotStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: vscode.Uri) {}

  /** Load persisted entries. Unreadable or tampered files are skipped, never fatal. */
  async load(): Promise<Snapshot> {
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, INDEX_FILE));
    } catch {
      return { entries: [], selectedId: undefined };
    }
    let index: IndexFile;
    try {
      index = JSON.parse(Buffer.from(raw).toString('utf8')) as IndexFile;
    } catch {
      return { entries: [], selectedId: undefined };
    }
    if (index.version !== INDEX_VERSION || !Array.isArray(index.records)) {
      return { entries: [], selectedId: undefined };
    }
    const entries: PlotEntry[] = [];
    for (const record of index.records) {
      if (!isRecord(record)) {
        continue;
      }
      try {
        const data = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.dir, record.file),
        );
        // Integrity check: the id must still be the hash of the content.
        if (contentId(record.mime, data) !== record.id) {
          continue;
        }
        entries.push({
          id: record.id,
          mime: record.mime,
          data,
          timestamp: record.timestamp,
          source: record.source,
          sourceKind: record.sourceKind,
        });
      } catch {
        // Missing image file: drop the record.
      }
    }
    const selectedId =
      typeof index.selectedId === 'string' && entries.some((e) => e.id === index.selectedId)
        ? index.selectedId
        : undefined;
    return { entries, selectedId };
  }

  /** Keep the store in sync with the history from now on. */
  attach(history: PlotHistory): vscode.Disposable {
    const unsubscribe = history.onDidChange(() => {
      const snapshot: Snapshot = {
        entries: [...history.entries],
        selectedId: history.selected?.id,
      };
      this.queue = this.queue.then(
        () => this.sync(snapshot),
        () => this.sync(snapshot),
      );
    });
    return new vscode.Disposable(unsubscribe);
  }

  /** Resolves when all scheduled writes have landed on disk. */
  flush(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  private async sync(snapshot: Snapshot): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.dir);
    const wanted = new Map<string, PlotEntry>();
    for (const entry of snapshot.entries) {
      wanted.set(fileNameFor(entry), entry);
    }
    const existing = new Set<string>();
    for (const [name, type] of await vscode.workspace.fs.readDirectory(this.dir)) {
      if (type === vscode.FileType.File && name !== INDEX_FILE) {
        existing.add(name);
      }
    }
    for (const [name, entry] of wanted) {
      if (!existing.has(name)) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, name), entry.data);
      }
    }
    for (const name of existing) {
      if (!wanted.has(name)) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(this.dir, name));
        } catch {
          // Best effort: a leftover file only wastes space.
        }
      }
    }
    const index: IndexFile = {
      version: INDEX_VERSION,
      selectedId: snapshot.selectedId,
      records: snapshot.entries.map((entry) => ({
        id: entry.id,
        mime: entry.mime,
        timestamp: entry.timestamp,
        source: entry.source,
        sourceKind: entry.sourceKind,
        file: fileNameFor(entry),
      })),
    };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.dir, INDEX_FILE),
      Buffer.from(JSON.stringify(index), 'utf8'),
    );
  }
}
