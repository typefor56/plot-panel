// Webview side of the Variables view. Plain JS, no build step, no network
// access. All dynamic content is created through DOM APIs; nothing is
// interpolated into HTML strings.
//
// The host sends the full grouped row list on every state message; filtering,
// section collapsing and the name-column width are ephemeral presentation
// state handled here. Children are fetched on demand through expand requests
// and cached in the DOM until the next full state.
//
// Layout doctrine: every row is a CSS grid over the same five tracks (name,
// value, type, size, viewer button), the first one sized by --name-width and
// type/size by the longest top-level text, so every column is one straight
// line. Indentation is applied inside the first
// cell, so the name|value boundary is the same vertical line on every row at
// every depth — that line is drawn (and dragged) by #splitter.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filter');
  const list = document.getElementById('list');
  const listWrap = document.getElementById('list-wrap');
  const splitter = document.getElementById('splitter');
  const typeSplitter = document.getElementById('type-splitter');
  const measure = document.getElementById('measure');
  const empty = document.getElementById('empty');

  /** Label of the notebook the variables belong to; undefined when none. */
  let targetLabel = undefined;
  let totalRows = 0;
  let nextRequestId = 1;
  /** requestId -> { box: HTMLElement, level: number } */
  const pending = new Map();
  /** Collapsed section categories, kept across refreshes of this webview. */
  const collapsedSections = new Set();
  /** [{ root, body }] for filtering. */
  let sections = [];
  /** Width chosen by the user, or undefined to keep auto-sizing to content. */
  let pinnedWidth = undefined;
  /** Same for the type column, set by the value|type splitter. */
  let pinnedTypeWidth = undefined;
  /** Current type and size track widths, in px, for the splitter math. */
  let typeWidth = 0;
  let sizeWidth = 0;
  /** Names currently shown at top level, for the auto measurement. */
  let topLevelNames = [];
  /** Type and size texts shown at top level, sizing their shared tracks. */
  let topLevelTypes = [];
  let topLevelSizes = [];

  const MIN_NAME_WIDTH = 60;
  /** Type names past this are elided: the column must not eat the row. */
  const MAX_TYPE_WIDTH = 150;
  /** Horizontal padding of the type and size cells. */
  const CELL_CHROME = 12;
  /** The viewer-button track, last in every row (see variables.css). */
  const VIEWER_TRACK = 22;
  const MIN_TYPE_WIDTH = 30;
  /** Chevron + gaps + the value cell's own padding. */
  const NAME_CHROME = 34;

  function clampWidth(width) {
    const available = listWrap.clientWidth || 300;
    const max = Math.max(MIN_NAME_WIDTH + 40, available - 90);
    return Math.min(Math.max(Math.round(width), MIN_NAME_WIDTH), max);
  }

  function applyWidth(width) {
    document.body.style.setProperty('--name-width', clampWidth(width) + 'px');
  }

  function widestOf(texts) {
    let widest = 0;
    for (const text of texts) {
      measure.textContent = text;
      widest = Math.max(widest, measure.offsetWidth);
    }
    return widest;
  }

  /** Right edge of the type track, measured from the list's left edge. */
  function typeTrackEnd() {
    return list.clientWidth - VIEWER_TRACK - sizeWidth;
  }

  function applyTypeWidth(width) {
    const nameWidth = Number.parseInt(
      getComputedStyle(document.body).getPropertyValue('--name-width'),
      10,
    );
    const max = Math.max(MIN_TYPE_WIDTH, typeTrackEnd() - nameWidth - 30);
    typeWidth = Math.min(Math.max(Math.round(width), MIN_TYPE_WIDTH), max);
    document.body.style.setProperty('--type-width', typeWidth + 'px');
  }

  /**
   * Size fits its longest top-level text; type too, unless the user dragged
   * the value|type splitter. The list's inner width is published so the
   * splitter, positioned from the right, tracks the scrollbar.
   */
  function sizeInfoColumns() {
    document.body.style.setProperty('--content-width', list.clientWidth + 'px');
    const sizes = widestOf(topLevelSizes);
    sizeWidth = sizes === 0 ? 0 : sizes + CELL_CHROME;
    document.body.style.setProperty('--size-width', sizeWidth + 'px');
    const types = widestOf(topLevelTypes);
    typeSplitter.hidden = types === 0;
    if (pinnedTypeWidth !== undefined) {
      applyTypeWidth(pinnedTypeWidth);
    } else {
      applyTypeWidth(types === 0 ? 0 : Math.min(types, MAX_TYPE_WIDTH) + CELL_CHROME);
    }
  }

  /**
   * Default width = the longest name, so no value is pushed out of alignment.
   * Only top-level names count: children are lazy and indenting the column to
   * the deepest possible descendant would waste most of the row.
   */
  function autoSizeNameColumn() {
    if (pinnedWidth !== undefined) {
      applyWidth(pinnedWidth);
      return;
    }
    applyWidth(widestOf(topLevelNames) + NAME_CHROME);
  }

  function makeNote(text) {
    const note = document.createElement('div');
    note.className = 'var-note';
    note.textContent = text;
    return note;
  }

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** Chevron pointing right; CSS rotates it 90° when the row is expanded. */
  function makeChevron() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.4');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', 'M6 4l4 4-4 4');
    svg.appendChild(path);
    return svg;
  }

  /** Small table/grid glyph, built via DOM APIs (no icon font, no CSP need). */
  function makeGridIcon() {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    const rect = document.createElementNS(SVG_NS, 'rect');
    rect.setAttribute('x', '1.5');
    rect.setAttribute('y', '2.5');
    rect.setAttribute('width', '13');
    rect.setAttribute('height', '11');
    rect.setAttribute('rx', '1');
    svg.appendChild(rect);
    const segments = [
      ['1.5', '6', '14.5', '6'],
      ['1.5', '9.75', '14.5', '9.75'],
      ['6', '6', '6', '13.5'],
      ['10.25', '6', '10.25', '13.5'],
    ];
    for (const [x1, y1, x2, y2] of segments) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', x1);
      line.setAttribute('y1', y1);
      line.setAttribute('x2', x2);
      line.setAttribute('y2', y2);
      svg.appendChild(line);
    }
    return svg;
  }

  /** The five grid cells shared by every row shape. */
  function makeCells(line, level) {
    line.style.setProperty('--level', String(level));
    const nameCell = document.createElement('span');
    nameCell.className = 'var-name-cell';
    const twistie = document.createElement('span');
    twistie.className = 'twistie';
    nameCell.appendChild(twistie);
    const name = document.createElement('span');
    name.className = 'var-name';
    nameCell.appendChild(name);
    const value = document.createElement('span');
    value.className = 'var-value';
    const type = document.createElement('span');
    type.className = 'var-hint';
    const size = document.createElement('span');
    size.className = 'var-size';
    const tail = document.createElement('span');
    tail.className = 'var-tail';
    line.appendChild(nameCell);
    line.appendChild(value);
    line.appendChild(type);
    line.appendChild(size);
    line.appendChild(tail);
    return { twistie, name, value, type, size, tail };
  }

  function makeRow(row, level) {
    const container = document.createElement('div');
    container.className = 'var-item';

    const line = document.createElement('div');
    line.className = 'var-row';
    const cells = makeCells(line, level);

    if (row.kind === 'ellipsis') {
      line.classList.add('var-ellipsis');
      cells.value.textContent = '⋯';
      cells.value.title = 'Truncated preview — open in the Data Viewer for full data';
      line.setAttribute('aria-hidden', 'true');
      container.appendChild(line);
      return container;
    }

    line.setAttribute('role', 'treeitem');
    cells.name.textContent = String(row.name);
    cells.name.title = String(row.name);
    if (row.changed === true) {
      line.classList.add('just-changed');
    }
    cells.value.textContent = row.value;
    cells.value.title = row.value;

    if (typeof row.viewerType === 'string' && row.viewerType.length > 0) {
      const viewer = document.createElement('button');
      viewer.className = 'viewer-button';
      viewer.title = 'Open in Data Viewer';
      viewer.setAttribute('aria-label', 'Open ' + row.name + ' in Data Viewer');
      viewer.appendChild(makeGridIcon());
      viewer.addEventListener('click', (event) => {
        // Never toggle the row expansion from the viewer button.
        event.stopPropagation();
        vscode.postMessage({
          type: 'openViewer',
          expression: row.expression,
          viewerType: row.viewerType,
        });
      });
      cells.tail.appendChild(viewer);
    }

    cells.type.textContent = row.typeHint;
    cells.type.title =
      typeof row.fullType === 'string' && row.fullType.length > 0 ? row.fullType : row.typeHint;
    if (typeof row.size === 'string') {
      cells.size.textContent = row.size;
    }

    container.appendChild(line);

    if (row.expandable) {
      line.classList.add('expandable-row');
      cells.twistie.appendChild(makeChevron());
      line.setAttribute('aria-expanded', 'false');
      line.tabIndex = 0;
      let box = null;
      let requested = false;
      let expanded = false;
      const toggle = () => {
        expanded = !expanded;
        line.setAttribute('aria-expanded', String(expanded));
        if (expanded && !requested) {
          requested = true;
          box = document.createElement('div');
          box.className = 'var-children';
          box.appendChild(makeNote('Loading…'));
          container.appendChild(box);
          const requestId = nextRequestId++;
          pending.set(requestId, { box, level });
          vscode.postMessage({
            type: 'expand',
            requestId,
            nodeId: row.nodeId,
            expression: row.expression,
          });
        }
        if (box !== null) {
          box.hidden = !expanded;
        }
      };
      line.addEventListener('click', toggle);
      line.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          toggle();
          event.preventDefault();
        }
      });
    }
    return container;
  }

  function makeSection(labelText) {
    const root = document.createElement('section');
    const header = document.createElement('div');
    header.className = 'section-header';
    const twistie = document.createElement('span');
    twistie.className = 'twistie';
    twistie.appendChild(makeChevron());
    const label = document.createElement('span');
    label.textContent = labelText;
    header.appendChild(twistie);
    header.appendChild(label);
    const body = document.createElement('div');
    const applyCollapsed = () => {
      const collapsed = collapsedSections.has(labelText);
      body.hidden = collapsed;
      header.setAttribute('aria-expanded', String(!collapsed));
      twistie.firstChild.style.transform = collapsed ? '' : 'rotate(90deg)';
    };
    header.addEventListener('click', () => {
      if (collapsedSections.has(labelText)) {
        collapsedSections.delete(labelText);
      } else {
        collapsedSections.add(labelText);
      }
      applyCollapsed();
    });
    applyCollapsed();
    root.appendChild(header);
    root.appendChild(body);
    return { root, body };
  }

  function updateEmpty(visibleCount) {
    if (totalRows === 0) {
      empty.textContent =
        targetLabel === undefined
          ? 'No active notebook. Open a notebook or the Interactive Window and run a cell.'
          : 'No variables yet. Run a cell in ' + targetLabel + '.';
      empty.hidden = false;
    } else if (visibleCount === 0) {
      empty.textContent = 'No variables match the filter.';
      empty.hidden = false;
    } else {
      empty.hidden = true;
    }
  }

  function applyFilter() {
    const query = filterInput.value.trim().toLowerCase();
    let visible = 0;
    for (const section of sections) {
      let sectionVisible = 0;
      for (const item of section.body.children) {
        const match = query === '' || (item.dataset.name || '').includes(query);
        item.hidden = !match;
        if (match) {
          sectionVisible++;
        }
      }
      section.root.hidden = sectionVisible === 0;
      visible += sectionVisible;
    }
    updateEmpty(visible);
  }

  function renderState(stateSections) {
    list.textContent = '';
    pending.clear();
    sections = [];
    totalRows = 0;
    topLevelNames = [];
    topLevelTypes = [];
    topLevelSizes = [];
    for (const stateSection of stateSections) {
      const section = makeSection(stateSection.label);
      sections.push(section);
      list.appendChild(section.root);
      const measurable = stateSection.label !== 'FUNCTIONS' && stateSection.label !== 'CLASSES';
      for (const row of stateSection.rows) {
        const item = makeRow(row, 0);
        item.dataset.name = String(row.name).toLowerCase();
        section.body.appendChild(item);
        if (measurable) {
          topLevelNames.push(String(row.name));
        }
        topLevelTypes.push(row.typeHint);
        if (typeof row.size === 'string' && row.size !== '') {
          topLevelSizes.push(row.size);
        }
        totalRows++;
      }
    }
    autoSizeNameColumn();
    sizeInfoColumns();
    applyFilter();
    // ponytail: a full rebuild of a long list could stay partly unpainted in
    // the webview until a scroll; re-assigning scrollTop on the next frame
    // forces that repaint. Drop it if Chromium stops needing it.
    requestAnimationFrame(() => {
      list.scrollTop = list.scrollTop;
    });
  }

  // --- the draggable column separators -----------------------------------

  function currentNameWidth() {
    return Number.parseInt(getComputedStyle(document.body).getPropertyValue('--name-width'), 10);
  }

  /**
   * Pointer and keyboard dragging for one separator. `move` takes the
   * pointer's x relative to the list; `commit` persists the result.
   */
  function makeDraggable(handle, move, nudge, commit) {
    let dragging = false;
    handle.addEventListener('pointerdown', (event) => {
      dragging = true;
      handle.classList.add('dragging');
      handle.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    handle.addEventListener('pointermove', (event) => {
      if (dragging) {
        move(event.clientX - listWrap.getBoundingClientRect().left);
      }
    });
    const end = (event) => {
      if (!dragging) {
        return;
      }
      dragging = false;
      handle.classList.remove('dragging');
      if (handle.hasPointerCapture(event.pointerId)) {
        handle.releasePointerCapture(event.pointerId);
      }
      commit();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
    handle.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowLeft' ? -8 : event.key === 'ArrowRight' ? 8 : 0;
      if (step !== 0) {
        nudge(step);
        commit();
        event.preventDefault();
      }
    });
  }

  makeDraggable(
    splitter,
    (x) => applyWidth(x),
    (step) => applyWidth(currentNameWidth() + step),
    () => {
      pinnedWidth = currentNameWidth();
      vscode.postMessage({ type: 'setNameWidth', width: pinnedWidth });
    },
  );

  // Double-click fits the type column to its longest name, however long.
  typeSplitter.addEventListener('dblclick', () => {
    applyTypeWidth(widestOf(topLevelTypes) + CELL_CHROME);
    pinnedTypeWidth = typeWidth;
    vscode.postMessage({ type: 'setTypeWidth', width: pinnedTypeWidth });
  });
  typeSplitter.title = 'Drag to resize the type column; double-click to fit the longest type';

  // Dragging right widens the value column, i.e. narrows the type column.
  makeDraggable(
    typeSplitter,
    (x) => applyTypeWidth(typeTrackEnd() - x),
    (step) => applyTypeWidth(typeWidth - step),
    () => {
      pinnedTypeWidth = typeWidth;
      vscode.postMessage({ type: 'setTypeWidth', width: pinnedTypeWidth });
    },
  );

  window.addEventListener('resize', () => {
    autoSizeNameColumn();
    sizeInfoColumns();
  });

  // The scrollbar appearing or going changes the inner width without a
  // window resize; the type splitter is placed from that width.
  new ResizeObserver(() => {
    document.body.style.setProperty('--content-width', list.clientWidth + 'px');
  }).observe(list);

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        targetLabel = message.target;
        pinnedWidth = typeof message.nameWidth === 'number' ? message.nameWidth : undefined;
        pinnedTypeWidth = typeof message.typeWidth === 'number' ? message.typeWidth : undefined;
        renderState(message.sections);
        document.body.classList.remove('busy');
        break;
      case 'columnWidths':
        pinnedWidth = typeof message.nameWidth === 'number' ? message.nameWidth : undefined;
        pinnedTypeWidth = typeof message.typeWidth === 'number' ? message.typeWidth : undefined;
        autoSizeNameColumn();
        sizeInfoColumns();
        break;
      case 'busy':
        document.body.classList.toggle('busy', message.busy === true);
        break;
      case 'children': {
        const info = pending.get(message.requestId);
        if (info === undefined) {
          break;
        }
        pending.delete(message.requestId);
        info.box.textContent = '';
        if (message.rows.length === 0) {
          info.box.appendChild(makeNote('No children.'));
          break;
        }
        for (const row of message.rows) {
          info.box.appendChild(makeRow(row, info.level + 1));
        }
        break;
      }
      case 'childrenError': {
        const info = pending.get(message.requestId);
        if (info === undefined) {
          break;
        }
        pending.delete(message.requestId);
        info.box.textContent = '';
        info.box.appendChild(makeNote(message.message));
        break;
      }
    }
  });

  filterInput.addEventListener('input', applyFilter);

  vscode.postMessage({ type: 'ready' });
})();
