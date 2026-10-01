import * as vscode from 'vscode';
import { contentId } from './hash';
import type { PlotHistory } from './history';
import { extensionForMime } from './mime';
import type { ThumbnailCache } from './thumbnails';
import type { PlotEntry, PlotSourceKind } from './types';

/**
 * Persistence of the plot history across restarts, in the extension's global
 * storage directory (never workspaceState, which is not meant for binary
 * data). Layout: one image file per distinct content, named by its hash (a
 * figure re-drawn identically by every Run All is stored once), an optional
 * <id>.thumb.png reduced preview per entry, plus an index.json with the
 * metadata, the run labels and the current selection.
 *
 * Writes are serialized through a promise queue and each sync is a full,
 * idempotent reconciliation of the directory against a snapshot, so crashes
 * can at worst lose the latest figures, never corrupt the store.
 */

const INDEX_FILE = 'index.json';
const INDEX_VERSION = 1;
const THUMB_SUFFIX = '.thumb.png';

interface IndexRecord {
  readonly id: string;
  readonly mime: string;
  readonly timestamp: number;
  readonly source: string;
  readonly sourceKind: PlotSourceKind;
  readonly file: string;
  /** Optional origin metadata (additive since the code actions; version stays 1). */
  readonly code?: string;
  readonly notebookUri?: string;
  readonly cellIndex?: number;
  readonly executionOrder?: number;
  /** Absent from stores written before per-run entries, where it was the id. */
  readonly contentHash?: string;
  readonly run?: number;
  readonly originUri?: string;
  readonly originLine?: number;
}

interface IndexFile {
  readonly version: number;
  readonly selectedId: string | undefined;
  readonly records: readonly IndexRecord[];
  /** run -> label, for the runs still in the history (additive, version 1). */
  readonly runLabels?: Readonly<Record<string, string>>;
}

export interface StoreSnapshot {
  readonly entries: readonly PlotEntry[];
  readonly selectedId: string | undefined;
  readonly thumbnails: ReadonlyMap<string, Uint8Array>;
  readonly runLabels: ReadonlyMap<number, string>;
}

function fileNameFor(entry: { contentHash: string; mime: string }): string {
  return `${entry.contentHash}.${extensionForMime(entry.mime)}`;
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
    !record.file.includes('\\') &&
    (record.code === undefined || typeof record.code === 'string') &&
    (record.notebookUri === undefined || typeof record.notebookUri === 'string') &&
    (record.cellIndex === undefined || typeof record.cellIndex === 'number') &&
    (record.executionOrder === undefined || typeof record.executionOrder === 'number') &&
    (record.contentHash === undefined || typeof record.contentHash === 'string') &&
    (record.run === undefined || typeof record.run === 'number') &&
    (record.originUri === undefined || typeof record.originUri === 'string') &&
    (record.originLine === undefined || typeof record.originLine === 'number')
  );
}

export class PlotStore {
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly dir: vscode.Uri) {}

  /** Load persisted entries. Unreadable or tampered files are skipped, never fatal. */
  async load(): Promise<StoreSnapshot> {
    const emptySnapshot: StoreSnapshot = {
      entries: [],
      selectedId: undefined,
      thumbnails: new Map(),
      runLabels: new Map(),
    };
    let raw: Uint8Array;
    try {
      raw = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.dir, INDEX_FILE));
    } catch {
      return emptySnapshot;
    }
    let index: IndexFile;
    try {
      index = JSON.parse(Buffer.from(raw).toString('utf8')) as IndexFile;
    } catch {
      return emptySnapshot;
    }
    if (index.version !== INDEX_VERSION || !Array.isArray(index.records)) {
      return emptySnapshot;
    }
    const entries: PlotEntry[] = [];
    const thumbnails = new Map<string, Uint8Array>();
    for (const record of index.records) {
      if (!isRecord(record)) {
        continue;
      }
      try {
        const data = await vscode.workspace.fs.readFile(
          vscode.Uri.joinPath(this.dir, record.file),
        );
        // Integrity check: the file must still hash to the recorded content.
        const contentHash = record.contentHash ?? record.id;
        if (contentId(record.mime, data) !== contentHash) {
          continue;
        }
        entries.push({
          id: record.id,
          contentHash,
          mime: record.mime,
          data,
          timestamp: record.timestamp,
          source: record.source,
          sourceKind: record.sourceKind,
          ...(record.code !== undefined ? { code: record.code } : {}),
          ...(record.notebookUri !== undefined ? { notebookUri: record.notebookUri } : {}),
          ...(record.cellIndex !== undefined ? { cellIndex: record.cellIndex } : {}),
      ...(record.executionOrder !== undefined ? { executionOrder: record.executionOrder } : {}),
          ...(record.run !== undefined ? { run: record.run } : {}),
          ...(record.originUri !== undefined ? { originUri: record.originUri } : {}),
          ...(record.originLine !== undefined ? { originLine: record.originLine } : {}),
        });
      } catch {
        // Missing image file: drop the record.
        continue;
      }
      try {
        thumbnails.set(
          record.id,
          await vscode.workspace.fs.readFile(
            vscode.Uri.joinPath(this.dir, `${record.id}${THUMB_SUFFIX}`),
          ),
        );
      } catch {
        // No thumbnail persisted: the webview will regenerate it.
      }
    }
    const selectedId =
      typeof index.selectedId === 'string' && entries.some((e) => e.id === index.selectedId)
        ? index.selectedId
        : undefined;
    const runLabels = new Map<number, string>();
    if (typeof index.runLabels === 'object' && index.runLabels !== null) {
      for (const [run, label] of Object.entries(index.runLabels)) {
        if (typeof label === 'string' && Number.isInteger(Number(run))) {
          runLabels.set(Number(run), label);
        }
      }
    }
    return { entries, selectedId, thumbnails, runLabels };
  }

  /** Keep the store in sync with the history and thumbnail cache from now on. */
  attach(history: PlotHistory, thumbnails: ThumbnailCache): vscode.Disposable {
    const schedule = (): void => {
      const kept = new Map<string, Uint8Array>();
      for (const entry of history.entries) {
        const thumb = thumbnails.get(entry.id);
        if (thumb !== undefined) {
          kept.set(entry.id, thumb);
        }
      }
      const snapshot: StoreSnapshot = {
        entries: [...history.entries],
        selectedId: history.selected?.id,
        thumbnails: kept,
        runLabels: history.runLabels,
      };
      this.queue = this.queue.then(
        () => this.sync(snapshot),
        () => this.sync(snapshot),
      );
    };
    const unsubscribeHistory = history.onDidChange(schedule);
    const unsubscribeThumbnails = thumbnails.onDidChange(schedule);
    return new vscode.Disposable(() => {
      unsubscribeHistory();
      unsubscribeThumbnails();
    });
  }

  /** Resolves when all scheduled writes have landed on disk. */
  flush(): Promise<void> {
    return this.queue.then(
      () => undefined,
      () => undefined,
    );
  }

  private async sync(snapshot: StoreSnapshot): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.dir);
    const wanted = new Map<string, Uint8Array>();
    for (const entry of snapshot.entries) {
      wanted.set(fileNameFor(entry), entry.data);
    }
    for (const [id, thumb] of snapshot.thumbnails) {
      wanted.set(`${id}${THUMB_SUFFIX}`, thumb);
    }
    const existing = new Set<string>();
    for (const [name, type] of await vscode.workspace.fs.readDirectory(this.dir)) {
      if (type === vscode.FileType.File && name !== INDEX_FILE) {
        existing.add(name);
      }
    }
    for (const [name, data] of wanted) {
      if (!existing.has(name)) {
        await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.dir, name), data);
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
        ...(entry.code !== undefined ? { code: entry.code } : {}),
        ...(entry.notebookUri !== undefined ? { notebookUri: entry.notebookUri } : {}),
        ...(entry.cellIndex !== undefined ? { cellIndex: entry.cellIndex } : {}),
      ...(entry.executionOrder !== undefined ? { executionOrder: entry.executionOrder } : {}),
        contentHash: entry.contentHash,
        ...(entry.run !== undefined ? { run: entry.run } : {}),
        ...(entry.originUri !== undefined ? { originUri: entry.originUri } : {}),
        ...(entry.originLine !== undefined ? { originLine: entry.originLine } : {}),
      })),
      runLabels: Object.fromEntries(snapshot.runLabels),
    };
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(this.dir, INDEX_FILE),
      Buffer.from(JSON.stringify(index), 'utf8'),
    );
  }
}
