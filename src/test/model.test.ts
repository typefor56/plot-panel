import * as assert from 'assert';
import { contentId } from '../hash';
import { PlotHistory } from '../history';
import { extensionForMime, findWidgetMime, pickImageItem } from '../mime';
import type { PlotEntry } from '../types';

function entry(id: string, mime = 'image/png'): PlotEntry {
  return {
    id,
    contentHash: id,
    mime,
    data: new Uint8Array([1, 2, 3]),
    timestamp: Date.now(),
    source: 'test.ipynb',
    sourceKind: 'notebook',
  };
}

function item(mime: string, bytes: number[] = [0]): { mime: string; data: Uint8Array } {
  return { mime, data: new Uint8Array(bytes) };
}

suite('mime selection', () => {
  test('prefers SVG over PNG', () => {
    const picked = pickImageItem([item('image/png'), item('image/svg+xml'), item('text/plain')]);
    assert.strictEqual(picked?.mime, 'image/svg+xml');
  });

  test('prefers PNG over JPEG', () => {
    const picked = pickImageItem([item('image/jpeg'), item('image/png')]);
    assert.strictEqual(picked?.mime, 'image/png');
  });

  test('returns undefined when no image representation exists', () => {
    const picked = pickImageItem([item('text/plain'), item('text/html')]);
    assert.strictEqual(picked, undefined);
  });

  test('detects widget outputs that have no static image', () => {
    assert.strictEqual(
      findWidgetMime([item('application/vnd.plotly.v1+json'), item('text/html')]),
      'application/vnd.plotly.v1+json',
    );
    assert.strictEqual(
      findWidgetMime([item('application/vnd.jupyter.widget-view+json')]),
      'application/vnd.jupyter.widget-view+json',
    );
    assert.strictEqual(findWidgetMime([item('image/png')]), undefined);
  });

  test('maps mime types to file extensions', () => {
    assert.strictEqual(extensionForMime('image/svg+xml'), 'svg');
    assert.strictEqual(extensionForMime('image/png'), 'png');
    assert.strictEqual(extensionForMime('image/jpeg'), 'jpg');
    assert.strictEqual(extensionForMime('application/octet-stream'), 'bin');
  });
});

suite('content hashing', () => {
  test('identical content yields identical ids, different content differs', () => {
    const a = contentId('image/png', new Uint8Array([1, 2, 3]));
    const b = contentId('image/png', new Uint8Array([1, 2, 3]));
    const c = contentId('image/png', new Uint8Array([1, 2, 4]));
    const d = contentId('image/svg+xml', new Uint8Array([1, 2, 3]));
    assert.strictEqual(a, b);
    assert.notStrictEqual(a, c);
    assert.notStrictEqual(a, d);
  });
});

suite('history: deduplication', () => {
  test('same content id is not stored twice', () => {
    const history = new PlotHistory(10);
    assert.strictEqual(history.add(entry('a'), true), 'added');
    assert.strictEqual(history.add(entry('a'), true), 'duplicate');
    assert.strictEqual(history.entries.length, 1);
  });

  test('a duplicate re-selects the existing entry when following', () => {
    const history = new PlotHistory(10);
    history.add(entry('a'), true);
    history.add(entry('b'), true);
    assert.strictEqual(history.selected?.id, 'b');
    history.add(entry('a'), true);
    assert.strictEqual(history.selected?.id, 'a');
    assert.strictEqual(history.entries.length, 2);
  });
});

suite('history: eviction', () => {
  test('oldest entries are evicted when the limit is exceeded', () => {
    const history = new PlotHistory(3);
    for (const id of ['a', 'b', 'c', 'd']) {
      history.add(entry(id), true);
    }
    assert.deepStrictEqual(
      history.entries.map((e) => e.id),
      ['b', 'c', 'd'],
    );
  });

  test('selection falls back to the oldest survivor when the selected entry is evicted', () => {
    const history = new PlotHistory(3);
    history.add(entry('a'), false);
    history.add(entry('b'), false);
    history.add(entry('c'), false);
    // First add auto-selects 'a' even without follow; keep it selected.
    assert.strictEqual(history.selected?.id, 'a');
    history.add(entry('d'), false); // evicts 'a'
    assert.strictEqual(history.selected?.id, 'b');
  });

  test('shrinking the limit evicts immediately and fixes the selection', () => {
    const history = new PlotHistory(10);
    for (const id of ['a', 'b', 'c', 'd']) {
      history.add(entry(id), false);
    }
    history.select('a');
    history.setLimit(2);
    assert.deepStrictEqual(
      history.entries.map((e) => e.id),
      ['c', 'd'],
    );
    assert.strictEqual(history.selected?.id, 'c');
  });

  test('eviction event carries the evicted ids', () => {
    const history = new PlotHistory(2);
    const evicted: string[] = [];
    history.onDidChange((event) => {
      if (event.type === 'evicted') {
        evicted.push(...event.ids);
      }
    });
    for (const id of ['a', 'b', 'c']) {
      history.add(entry(id), true);
    }
    assert.deepStrictEqual(evicted, ['a']);
  });
});

suite('history: selection and follow', () => {
  test('follow keeps the newest entry selected', () => {
    const history = new PlotHistory(10);
    history.add(entry('a'), true);
    history.add(entry('b'), true);
    assert.strictEqual(history.selected?.id, 'b');
  });

  test('without follow the current selection is kept', () => {
    const history = new PlotHistory(10);
    history.add(entry('a'), true);
    history.add(entry('b'), false);
    assert.strictEqual(history.selected?.id, 'a');
  });

  test('next/previous navigate and clamp at both ends', () => {
    const history = new PlotHistory(10);
    for (const id of ['a', 'b', 'c']) {
      history.add(entry(id), true);
    }
    assert.strictEqual(history.selected?.id, 'c');
    history.next(); // already at newest: no change
    assert.strictEqual(history.selected?.id, 'c');
    history.previous();
    history.previous();
    assert.strictEqual(history.selected?.id, 'a');
    history.previous(); // already at oldest: no change
    assert.strictEqual(history.selected?.id, 'a');
    history.next();
    assert.strictEqual(history.selected?.id, 'b');
  });

  test('clear empties everything and drops the selection', () => {
    const history = new PlotHistory(10);
    history.add(entry('a'), true);
    history.clear();
    assert.strictEqual(history.entries.length, 0);
    assert.strictEqual(history.selected, undefined);
    assert.strictEqual(history.selectedIndex, -1);
  });
});
