// Webview side of the Jupyter Variables view. Plain JS, no build step, no
// network access. All dynamic content is created through DOM APIs; nothing
// is interpolated into HTML strings.
//
// The host sends the full grouped row list on every state message; filtering
// and section collapsing are ephemeral presentation state handled here.
// Children are fetched on demand through expand requests and cached in the
// DOM until the next full state.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const filterInput = document.getElementById('filter');
  const list = document.getElementById('list');
  const empty = document.getElementById('empty');

  /** Label of the notebook the variables belong to; undefined when none. */
  let targetLabel = undefined;
  let totalRows = 0;
  let nextRequestId = 1;
  /** requestId -> { box: HTMLElement, level: number } */
  const pending = new Map();
  /** Collapsed section categories, kept across refreshes of this webview. */
  const collapsedSections = new Set();
  /** [{ root, body, header }] for filtering. */
  let sections = [];

  function makeNote(text) {
    const note = document.createElement('div');
    note.className = 'var-note';
    note.textContent = text;
    return note;
  }

  function makeRow(row, level) {
    const container = document.createElement('div');
    container.className = 'var-item';

    if (row.kind === 'ellipsis') {
      const gap = document.createElement('div');
      gap.className = 'var-row var-ellipsis';
      gap.textContent = '⋯';
      gap.title = 'Truncated preview — open in the Data Viewer for full data';
      gap.setAttribute('aria-hidden', 'true');
      container.appendChild(gap);
      return container;
    }

    const line = document.createElement('div');
    line.className = 'var-row';
    line.setAttribute('role', 'treeitem');
    line.style.paddingLeft = 4 + level * 14 + 'px';

    const twistie = document.createElement('span');
    twistie.className = 'twistie';
    twistie.textContent = '▸';
    line.appendChild(twistie);

    const name = document.createElement('span');
    name.className = 'var-name';
    name.textContent = String(row.name);
    name.title = String(row.name);
    line.appendChild(name);

    const value = document.createElement('span');
    value.className = 'var-value';
    value.textContent = row.value;
    value.title = row.value;
    line.appendChild(value);

    const hint = document.createElement('span');
    hint.className = 'var-hint';
    hint.textContent = row.typeHint;
    hint.title = row.typeHint;
    line.appendChild(hint);

    container.appendChild(line);

    if (row.expandable) {
      line.classList.add('expandable-row');
      twistie.classList.add('expandable');
      line.setAttribute('aria-expanded', 'false');
      line.tabIndex = 0;
      let box = null;
      let requested = false;
      let expanded = false;
      const toggle = () => {
        expanded = !expanded;
        twistie.textContent = expanded ? '▾' : '▸';
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
    twistie.className = 'twistie expandable';
    const label = document.createElement('span');
    label.textContent = labelText;
    header.appendChild(twistie);
    header.appendChild(label);
    const body = document.createElement('div');
    const applyCollapsed = () => {
      const collapsed = collapsedSections.has(labelText);
      body.hidden = collapsed;
      twistie.textContent = collapsed ? '▸' : '▾';
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
    for (const stateSection of stateSections) {
      const section = makeSection(stateSection.label);
      sections.push(section);
      list.appendChild(section.root);
      for (const row of stateSection.rows) {
        const item = makeRow(row, 0);
        item.dataset.name = String(row.name).toLowerCase();
        section.body.appendChild(item);
        totalRows++;
      }
    }
    applyFilter();
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        targetLabel = message.target;
        renderState(message.sections);
        document.body.classList.remove('busy');
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
