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
  /** id of the figure opening a run -> that run's number. Recomputed by the
   *  host on every history change, so eviction cannot orphan a label. */
  let runLabels = new Map();

  /** @type {'gallery' | 'single'} 'single' pins one entry: no strip, no navigation. */
  let sessionMode = 'gallery';
  /** Host-owned display mode; the webview only projects it. */
  let displayMode = 'fit';

  const ZOOM_FACTORS = { 'zoom-50': 0.5, 'zoom-75': 0.75, 'zoom-200': 2 };

  /** Apply the explicit pixel width required by zoom presets (CSS covers the rest). */
  function sizeFigure() {
    figure.style.width = '';
    const factor = ZOOM_FACTORS[displayMode];
    if (factor !== undefined && figure.naturalWidth > 0) {
      // naturalWidth is 0 for dimensionless SVG: leave it unsized, the 'fit'
      // rules in CSS are the fallback.
      figure.style.width = Math.round(figure.naturalWidth * factor) + 'px';
    }
  }

  function applyDisplay(display) {
    displayMode = display.mode;
    document.body.dataset.displayMode = display.mode;
    document.body.classList.toggle('dark-filter', display.darkFilter === true);
    sizeFigure();
  }

  figure.addEventListener('load', sizeFigure);
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
    if (sessionMode === 'single') {
      strip.textContent = '';
      strip.hidden = true;
      renderSelection();
      return;
    }
    strip.textContent = '';
    for (const entry of entries) {
      // Each run opens with a labelled divider, so a long history reads as
      // "the figures from that run" rather than one undifferentiated wall.
      const run = runLabels.get(entry.id);
      if (run !== undefined) {
        const marker = document.createElement('div');
        marker.className = 'run-marker';
        const label = document.createElement('span');
        label.className = 'run-label';
        label.textContent = 'Run ' + run;
        marker.appendChild(label);
        marker.title = 'Figures produced by run ' + run;
        strip.appendChild(marker);
      }
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

  function dataUriToBlob(dataUri) {
    const comma = dataUri.indexOf(',');
    const meta = dataUri.slice(0, comma);
    const mime = meta.slice(5, meta.indexOf(';'));
    const binary = atob(dataUri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
  }

  function rasterizeToPng(dataUri) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, image.width);
        canvas.height = Math.max(1, image.height);
        const context = canvas.getContext('2d');
        if (context === null) {
          reject(new Error('canvas 2d context unavailable'));
          return;
        }
        context.drawImage(image, 0, 0);
        canvas.toBlob((blob) => {
          if (blob === null) {
            reject(new Error('PNG encoding failed'));
          } else {
            resolve(blob);
          }
        }, 'image/png');
      };
      image.onerror = () => reject(new Error('image decoding failed'));
      image.src = dataUri;
    });
  }

  async function handleCopy(message) {
    try {
      const blob =
        message.mime === 'image/png'
          ? dataUriToBlob(message.dataUri)
          : await rasterizeToPng(message.dataUri);
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      vscode.postMessage({ type: 'copyResult', ok: true });
    } catch (error) {
      vscode.postMessage({ type: 'copyResult', ok: false, error: String(error) });
    }
  }

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        sessionMode = message.sessionMode === 'single' ? 'single' : 'gallery';
        applyDisplay(message.display);
        entries = message.entries.slice();
        runLabels = new Map((message.runs || []).map((label) => [label.id, label.run]));
        selectedId = message.selectedId;
        requested.clear();
        renderNotice(message.notice);
        renderStrip();
        if (sessionMode === 'single' && selectedId !== undefined) {
          // Lets a single-plot editor panel be revived after a window reload.
          vscode.setState({ pinnedId: selectedId });
        }
        break;
      case 'added':
        // Single sessions stay pinned; the host does not send this, but stay safe.
        if (sessionMode === 'single') {
          break;
        }
        entries.push(message.entry);
        renderNotice(undefined);
        renderStrip();
        break;
      case 'runs':
        runLabels = new Map(message.runs.map((label) => [label.id, label.run]));
        renderStrip();
        break;
      case 'evicted':
        entries = entries.filter((entry) => !message.ids.includes(entry.id));
        if (sessionMode === 'single' && selectedId !== undefined && findEntry(selectedId) === undefined) {
          selectedId = undefined;
          renderNotice('This plot was removed from the history.');
        }
        renderStrip();
        break;
      case 'selected':
        if (sessionMode === 'single') {
          break;
        }
        selectedId = message.id;
        renderSelection();
        break;
      case 'cleared':
        runLabels = new Map();
        entries = [];
        requested.clear();
        if (sessionMode === 'single' && selectedId !== undefined) {
          renderNotice('This plot was removed from the history.');
        } else {
          renderNotice(undefined);
        }
        selectedId = undefined;
        renderStrip();
        break;
      case 'notice':
        renderNotice(message.text);
        break;
      case 'display':
        applyDisplay(message.display);
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
      case 'copy':
        void handleCopy(message);
        break;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (sessionMode !== 'gallery') {
      return;
    }
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
