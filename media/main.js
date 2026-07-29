// Webview side of the Plots view. Plain JS, no build step, no network access.
// All dynamic content is created through DOM APIs; nothing is interpolated
// into HTML strings.
//
// The extension sends reduced thumbnails plus the full image of the selected
// entry only. Missing full images are requested on demand, and bitmap
// thumbnails are generated here (the extension host has no canvas) and posted
// back for caching and persistence.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const figure = document.getElementById('figure');
  const empty = document.getElementById('empty');
  const notice = document.getElementById('notice');
  const strip = document.getElementById('strip');

  const THUMB_MAX = 160;

  /** @type {{ id: string, mime: string, source: string, timestamp: number, thumbUri?: string, dataUri?: string, thumbPending?: boolean }[]} */
  let entries = [];
  /** @type {string | undefined} */
  let selectedId = undefined;
  /** @type {Set<string>} ids whose full image has been requested */
  const requested = new Set();

  function findEntry(id) {
    return entries.find((entry) => entry.id === id);
  }

  function requestImage(entry) {
    if (entry.dataUri === undefined && !requested.has(entry.id)) {
      requested.add(entry.id);
      vscode.postMessage({ type: 'requestImage', id: entry.id });
    }
  }

  function maybeGenerateThumbnail(entry) {
    if (
      entry.mime === 'image/svg+xml' ||
      entry.thumbUri !== undefined ||
      entry.dataUri === undefined ||
      entry.thumbPending
    ) {
      return;
    }
    entry.thumbPending = true;
    const image = new Image();
    image.onload = () => {
      entry.thumbPending = false;
      const scale = Math.min(1, THUMB_MAX / Math.max(image.width, image.height, 1));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (context === null) {
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      try {
        entry.thumbUri = canvas.toDataURL('image/png');
      } catch {
        return;
      }
      vscode.postMessage({ type: 'thumbnail', id: entry.id, dataUri: entry.thumbUri });
      const button = strip.querySelector('.thumb[data-id="' + CSS.escape(entry.id) + '"] img');
      if (button !== null) {
        button.src = entry.thumbUri;
      }
    };
    image.onerror = () => {
      entry.thumbPending = false;
    };
    image.src = entry.dataUri;
  }

  function renderFigure() {
    const selected = selectedId !== undefined ? findEntry(selectedId) : undefined;
    if (selected === undefined) {
      figure.hidden = true;
      figure.removeAttribute('src');
      empty.hidden = entries.length !== 0;
      return;
    }
    empty.hidden = true;
    if (selected.dataUri === undefined) {
      // Show the thumbnail as a placeholder while the full image arrives.
      requestImage(selected);
      if (selected.thumbUri !== undefined) {
        figure.src = selected.thumbUri;
        figure.hidden = false;
      } else {
        figure.hidden = true;
        figure.removeAttribute('src');
      }
      return;
    }
    figure.src = selected.dataUri;
    const when = new Date(selected.timestamp).toLocaleTimeString();
    figure.alt = 'Plot from ' + selected.source + ' at ' + when;
    figure.title = figure.alt;
    figure.hidden = false;
  }

  function thumbSource(entry) {
    if (entry.thumbUri !== undefined) {
      return entry.thumbUri;
    }
    if (entry.dataUri !== undefined) {
      return entry.dataUri;
    }
    // Neither thumbnail nor data (e.g. restored from an old store): fetch the
    // full image, the thumbnail will be derived from it.
    requestImage(entry);
    return undefined;
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
      const source = thumbSource(entry);
      if (source !== undefined) {
        img.src = source;
      }
      img.alt = 'Plot from ' + entry.source;
      img.draggable = false;
      button.appendChild(img);
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'select', id: entry.id });
      });
      strip.appendChild(button);
      maybeGenerateThumbnail(entry);
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
        requested.clear();
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
        requested.clear();
        renderNotice(undefined);
        renderStrip();
        break;
      case 'notice':
        renderNotice(message.text);
        break;
      case 'image': {
        const entry = findEntry(message.id);
        if (entry !== undefined) {
          entry.dataUri = message.dataUri;
          maybeGenerateThumbnail(entry);
          if (entry.id === selectedId) {
            renderFigure();
          }
          const img = strip.querySelector('.thumb[data-id="' + CSS.escape(entry.id) + '"] img');
          if (img !== null && !img.hasAttribute('src') && entry.thumbUri === undefined) {
            img.src = message.dataUri;
          }
        }
        break;
      }
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
