import * as assert from 'assert';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { contentId } from '../hash';
import { PlotHistory } from '../history';
import { PlotStore } from '../persistence';
import { ThumbnailCache } from '../thumbnails';
import type { PlotEntry } from '../types';

function makeEntry(bytes: number[], mime = 'image/png'): PlotEntry {
  const data = new Uint8Array(bytes);
  return {
    id: contentId(mime, data),
    mime,
    data,
    timestamp: 1700000000000,
    source: 'roundtrip.ipynb',
    sourceKind: 'notebook',
  };
}

function tempStoreDir(): vscode.Uri {
  const dir = path.join(
    os.tmpdir(),
    `plot-panel-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  return vscode.Uri.file(dir);
}

suite('persistence round trip on disk', () => {
  test('history survives a save/load cycle byte-for-byte', async () => {
    const dir = tempStoreDir();
    const history = new PlotHistory(10);
    const store = new PlotStore(dir);
    const subscription = store.attach(history, new ThumbnailCache());
    try {
      const a = makeEntry([1, 2, 3], 'image/png');
      const b = makeEntry([4, 5, 6], 'image/svg+xml');
      history.add(a, true);
      history.add(b, true);
      history.select(a.id);
      await store.flush();

      const reloaded = await new PlotStore(dir).load();
      assert.strictEqual(reloaded.entries.length, 2);
      assert.deepStrictEqual(
        reloaded.entries.map((e) => e.id),
        [a.id, b.id],
      );
      const first = reloaded.entries[0];
      assert.ok(first);
      assert.deepStrictEqual(Buffer.from(first.data), Buffer.from(a.data));
      assert.strictEqual(first.mime, 'image/png');
      assert.strictEqual(first.timestamp, a.timestamp);
      assert.strictEqual(first.source, 'roundtrip.ipynb');
      assert.strictEqual(reloaded.selectedId, a.id);
    } finally {
      subscription.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });

  test('code metadata round-trips, and records without it still load', async () => {
    const dir = tempStoreDir();
    const history = new PlotHistory(10);
    const store = new PlotStore(dir);
    const subscription = store.attach(history, new ThumbnailCache());
    try {
      const bare = makeEntry([1, 2, 3]);
      const annotated: PlotEntry = {
        ...makeEntry([4, 5, 6]),
        code: 'plt.plot(x)',
        notebookUri: 'file:///tmp/roundtrip.ipynb',
        cellIndex: 3,
        originUri: 'file:///tmp/script.py',
        originLine: 12,
      };
      history.add(bare, true);
      history.add(annotated, true);
      await store.flush();

      const reloaded = await new PlotStore(dir).load();
      assert.strictEqual(reloaded.entries.length, 2);
      const first = reloaded.entries[0];
      const second = reloaded.entries[1];
      assert.ok(first && second);
      // An old-style record without the optional fields loads untouched.
      assert.strictEqual(first.code, undefined);
      assert.strictEqual(first.notebookUri, undefined);
      assert.strictEqual(second.code, 'plt.plot(x)');
      assert.strictEqual(second.notebookUri, 'file:///tmp/roundtrip.ipynb');
      assert.strictEqual(second.cellIndex, 3);
      assert.strictEqual(second.originUri, 'file:///tmp/script.py');
      assert.strictEqual(second.originLine, 12);
    } finally {
      subscription.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });

  test('evicted and cleared entries disappear from disk', async () => {
    const dir = tempStoreDir();
    const history = new PlotHistory(2);
    const store = new PlotStore(dir);
    const subscription = store.attach(history, new ThumbnailCache());
    try {
      history.add(makeEntry([1]), true);
      history.add(makeEntry([2]), true);
      history.add(makeEntry([3]), true); // evicts the first entry
      await store.flush();

      let reloaded = await new PlotStore(dir).load();
      assert.strictEqual(reloaded.entries.length, 2);
      const files = await vscode.workspace.fs.readDirectory(dir);
      const images = files.filter(([name]) => name.endsWith('.png'));
      assert.strictEqual(images.length, 2, 'evicted image file must be deleted');

      history.clear();
      await store.flush();
      reloaded = await new PlotStore(dir).load();
      assert.strictEqual(reloaded.entries.length, 0);
    } finally {
      subscription.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });

  test('a missing or corrupted store loads as empty, never throws', async () => {
    const missing = await new PlotStore(tempStoreDir()).load();
    assert.deepStrictEqual(missing.entries, []);
    assert.strictEqual(missing.selectedId, undefined);
    assert.strictEqual(missing.thumbnails.size, 0);

    const dir = tempStoreDir();
    await vscode.workspace.fs.createDirectory(dir);
    await vscode.workspace.fs.writeFile(
      vscode.Uri.joinPath(dir, 'index.json'),
      Buffer.from('not json at all', 'utf8'),
    );
    try {
      const corrupted = await new PlotStore(dir).load();
      assert.deepStrictEqual(corrupted.entries, []);
      assert.strictEqual(corrupted.selectedId, undefined);
    } finally {
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });

  test('thumbnails survive the round trip and stale ones are removed', async () => {
    const dir = tempStoreDir();
    const history = new PlotHistory(10);
    const thumbnails = new ThumbnailCache();
    const store = new PlotStore(dir);
    const subscription = store.attach(history, thumbnails);
    try {
      const entry = makeEntry([1, 2, 3]);
      history.add(entry, true);
      thumbnails.set(entry.id, new Uint8Array([7, 7, 7]));
      await store.flush();

      const reloaded = await new PlotStore(dir).load();
      const thumb = reloaded.thumbnails.get(entry.id);
      assert.ok(thumb, 'thumbnail must be persisted');
      assert.deepStrictEqual(Buffer.from(thumb), Buffer.from([7, 7, 7]));

      history.clear();
      thumbnails.prune(new Set());
      await store.flush();
      const names = (await vscode.workspace.fs.readDirectory(dir)).map(([name]) => name);
      assert.ok(
        !names.some((name) => name.endsWith('.thumb.png')),
        'stale thumbnail files must be deleted',
      );
    } finally {
      subscription.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });

  test('tampered image content is dropped by the integrity check', async () => {
    const dir = tempStoreDir();
    const history = new PlotHistory(10);
    const store = new PlotStore(dir);
    const subscription = store.attach(history, new ThumbnailCache());
    try {
      const entry = makeEntry([9, 9, 9]);
      history.add(entry, true);
      await store.flush();
      await vscode.workspace.fs.writeFile(
        vscode.Uri.joinPath(dir, `${entry.id}.png`),
        Buffer.from([0, 0, 0]),
      );
      const reloaded = await new PlotStore(dir).load();
      assert.strictEqual(reloaded.entries.length, 0);
    } finally {
      subscription.dispose();
      await vscode.workspace.fs.delete(dir, { recursive: true, useTrash: false });
    }
  });
});
