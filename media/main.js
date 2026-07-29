// Webview side of the Plots view. Plain JS, no build step, no network access.
// All dynamic content is created through DOM APIs; nothing is interpolated
// into HTML strings.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const figure = document.getElementById('figure');
  const empty = document.getElementById('empty');
  const notice = document.getElementById('notice');
  const strip = document.getElementById('strip');

  /** @type {{ id: string, mime: string, dataUri: string, source: string, timestamp: number }[]} */
  let entries = [];
  /** @type {string | undefined} */
  let selectedId = undefined;

  function findEntry(id) {
    return entries.find((entry) => entry.id === id);
  }

  function renderFigure() {
    const selected = selectedId !== undefined ? findEntry(selectedId) : undefined;
    if (selected === undefined) {
      figure.hidden = true;
      figure.removeAttribute('src');
      empty.hidden = entries.length !== 0;
    } else {
      figure.src = selected.dataUri;
      const when = new Date(selected.timestamp).toLocaleTimeString();
      figure.alt = 'Plot from ' + selected.source + ' at ' + when;
      figure.title = figure.alt;
      figure.hidden = false;
      empty.hidden = true;
    }
  }

  function renderStrip() {
    strip.textContent = '';
    for (const entry of entries) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'thumb';
      button.dataset.id = entry.id;
      button.setAttribute('role', 'option');
      const img = document.createElement('img');
      img.src = entry.dataUri;
      img.alt = 'Plot from ' + entry.source;
      img.draggable = false;
      button.appendChild(img);
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'select', id: entry.id });
      });
      strip.appendChild(button);
    }
    strip.hidden = entries.length === 0;
    renderSelection();
  }

  function renderSelection() {
    for (const button of strip.querySelectorAll('.thumb')) {
      const isSelected = button.dataset.id === selectedId;
      button.classList.toggle('selected', isSelected);
      button.setAttribute('aria-selected', String(isSelected));
      if (isSelected) {
        button.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    renderFigure();
  }

  function renderNotice(text) {
    if (text) {
      notice.textContent = text;
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        entries = message.entries.slice();
        selectedId = message.selectedId;
        renderNotice(message.notice);
        renderStrip();
        break;
      case 'added':
        entries.push(message.entry);
        renderNotice(undefined);
        renderStrip();
        break;
      case 'evicted':
        entries = entries.filter((entry) => !message.ids.includes(entry.id));
        renderStrip();
        break;
      case 'selected':
        selectedId = message.id;
        renderSelection();
        break;
      case 'cleared':
        entries = [];
        selectedId = undefined;
        renderNotice(undefined);
        renderStrip();
        break;
      case 'notice':
        renderNotice(message.text);
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') {
      vscode.postMessage({ type: 'nav', direction: 'previous' });
      event.preventDefault();
    } else if (event.key === 'ArrowRight') {
      vscode.postMessage({ type: 'nav', direction: 'next' });
      event.preventDefault();
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
