// Webview side of the Variables view. Plain JS, no build step, no network
// access. All dynamic content is created through DOM APIs; nothing is
// interpolated into HTML strings.
//
// The host sends the full grouped row list on every state message; filtering,
// section collapsing and the name-column width are ephemeral presentation
// state handled here. Children are fetched on demand through expand requests
// and cached in the DOM until the next full state.
//
// Layout doctrine: every row is a CSS grid over the same three tracks, the
// first one sized by --name-width. Indentation is applied inside the first
// cell, so the name|value boundary is the same vertical line on every row at
// every depth — that line is drawn (and dragged) by #splitter.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filter');
  const list = document.getElementById('list');
  const listWrap = document.getElementById('list-wrap');
  const splitter = document.getElementById('splitter');
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
  /** Names currently shown at top level, for the auto measurement. */
  let topLevelNames = [];

  const MIN_NAME_WIDTH = 60;
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
    let widest = 0;
    for (const name of topLevelNames) {
      measure.textContent = name;
      widest = Math.max(widest, measure.offsetWidth);
    }
    applyWidth(widest + NAME_CHROME);
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

  /** The three grid cells shared by every row shape. */
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
    const tail = document.createElement('span');
    tail.className = 'var-tail';
    line.appendChild(nameCell);
    line.appendChild(value);
    line.appendChild(tail);
    return { twistie, name, value, tail };
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

    const hint = document.createElement('span');
    hint.className = 'var-hint';
    hint.textContent = row.typeHint;
    hint.title = row.typeHint;
    cells.tail.appendChild(hint);

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
          vscode.postMessage({ type: 'expand', requestId, expression: row.expression });
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
    for (const stateSection of stateSections) {
      const section = makeSection(stateSection.label);
      sections.push(section);
      list.appendChild(section.root);
      for (const row of stateSection.rows) {
        const item = makeRow(row, 0);
        item.dataset.name = String(row.name).toLowerCase();
        section.body.appendChild(item);
        topLevelNames.push(String(row.name));
        totalRows++;
      }
    }
    autoSizeNameColumn();
    applyFilter();
  }

  // --- the draggable column separator -------------------------------------

  let dragging = false;

  splitter.addEventListener('pointerdown', (event) => {
    dragging = true;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(event.pointerId);
    event.preventDefault();
  });

  splitter.addEventListener('pointermove', (event) => {
    if (!dragging) {
      return;
    }
    applyWidth(event.clientX - listWrap.getBoundingClientRect().left);
  });

  function endDrag(event) {
    if (!dragging) {
      return;
    }
    dragging = false;
    splitter.classList.remove('dragging');
    if (splitter.hasPointerCapture(event.pointerId)) {
      splitter.releasePointerCapture(event.pointerId);
    }
    pinnedWidth = Number.parseInt(
      getComputedStyle(document.body).getPropertyValue('--name-width'),
      10,
    );
    vscode.postMessage({ type: 'setNameWidth', width: pinnedWidth });
  }

  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);

  splitter.addEventListener('keydown', (event) => {
    const step = event.key === 'ArrowLeft' ? -8 : event.key === 'ArrowRight' ? 8 : 0;
    if (step === 0) {
      return;
    }
    const current = Number.parseInt(
      getComputedStyle(document.body).getPropertyValue('--name-width'),
      10,
    );
    applyWidth(current + step);
    pinnedWidth = Number.parseInt(
      getComputedStyle(document.body).getPropertyValue('--name-width'),
      10,
    );
    vscode.postMessage({ type: 'setNameWidth', width: pinnedWidth });
    event.preventDefault();
  });

  window.addEventListener('resize', () => {
    autoSizeNameColumn();
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        targetLabel = message.target;
        pinnedWidth = typeof message.nameWidth === 'number' ? message.nameWidth : undefined;
        renderState(message.sections);
        document.body.classList.remove('busy');
        break;
      case 'nameWidth':
        pinnedWidth = typeof message.width === 'number' ? message.width : undefined;
        autoSizeNameColumn();
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
