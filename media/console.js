// Webview side of the Console. Plain JS, no build step, no network access.
// All dynamic content is created through DOM APIs; nothing is interpolated
// into HTML strings.
//
// The host owns the sessions and their transcripts; this file renders them
// and sends back what the user typed. Only the input history and the caret
// live here.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const tabs = document.getElementById('tabs');
  const scrollback = document.getElementById('scrollback');
  const promptLabel = document.getElementById('prompt');
  const input = document.getElementById('input');
  const popup = document.getElementById('completions');

  /** Submitted lines, oldest first; browsed with the arrow keys. */
  const history = [];
  let historyIndex = 0;
  /** Text being edited when the user started browsing history. */
  let draft = '';

  function atBottom() {
    return scrollback.scrollHeight - scrollback.scrollTop - scrollback.clientHeight < 24;
  }

  // Nothing here interprets terminal escapes, and a library that colours its
  // own output would otherwise show the raw codes.
  const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

  function appendEntry(entry, stick) {
    const line = document.createElement('span');
    line.className = 'line-' + entry.kind;
    line.textContent = entry.text.replace(ANSI, '');
    scrollback.appendChild(line);
    if (stick) {
      scrollback.scrollTop = scrollback.scrollHeight;
    }
  }

  function renderTranscript(entries) {
    scrollback.textContent = '';
    for (const entry of entries) {
      appendEntry(entry, false);
    }
    scrollback.scrollTop = scrollback.scrollHeight;
  }

  function makeTab(session) {
    const tab = document.createElement('button');
    tab.className = session.active ? 'tab active' : 'tab';
    tab.type = 'button';
    tab.setAttribute('aria-pressed', String(session.active));

    const pip = document.createElement('span');
    pip.className = 'tab-pip';
    if (session.state === 'busy' || session.state === 'starting') {
      pip.classList.add('busy');
    } else if (session.state === 'exited') {
      pip.classList.add('exited');
    }
    tab.appendChild(pip);

    const label = document.createElement('span');
    label.textContent = session.label;
    tab.appendChild(label);
    tab.addEventListener('click', () => {
      vscode.postMessage({ type: 'select', id: session.id });
      input.focus();
    });

    const close = document.createElement('span');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = 'Close session';
    close.setAttribute('role', 'button');
    close.tabIndex = 0;
    const closeSession = (event) => {
      event.stopPropagation();
      vscode.postMessage({ type: 'close', id: session.id });
    };
    close.addEventListener('click', closeSession);
    close.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        closeSession(event);
        event.preventDefault();
      }
    });
    tab.appendChild(close);
    return tab;
  }

  // No "+" here: the title bar already carries one, next to interrupt and
  // restart, and two buttons for the same action is one too many.
  function renderTabs(sessions) {
    tabs.textContent = '';
    for (const session of sessions) {
      tabs.appendChild(makeTab(session));
    }
  }

  function applyStatus(prompt, busy) {
    promptLabel.textContent = prompt;
    document.body.classList.toggle('busy', busy === true);
  }

  function resize() {
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
  }

  function submit() {
    closeCompletions();
    const code = input.value;
    if (code.trim().length > 0) {
      history.push(code);
    }
    historyIndex = history.length;
    draft = '';
    input.value = '';
    resize();
    vscode.postMessage({ type: 'execute', code });
  }

  function browseHistory(delta) {
    if (history.length === 0) {
      return false;
    }
    if (historyIndex === history.length) {
      draft = input.value;
    }
    const next = historyIndex + delta;
    if (next < 0 || next > history.length) {
      return false;
    }
    historyIndex = next;
    input.value = next === history.length ? draft : history[next];
    resize();
    // Caret to the end, so the next keystroke continues the recalled line.
    input.setSelectionRange(input.value.length, input.value.length);
    return true;
  }

  // --- completions ---------------------------------------------------------

  const INDENT = '    ';
  let completionStart = 0;
  let completionItems = [];
  let selected = 0;
  let completionTimer = 0;
  let completionToken = 0;

  function completionsOpen() {
    return completionItems.length > 0;
  }

  function closeCompletions() {
    completionItems = [];
    selected = 0;
    popup.hidden = true;
    popup.textContent = '';
  }

  function renderCompletions() {
    popup.textContent = '';
    completionItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = index === selected ? 'completion selected' : 'completion';
      row.textContent = item;
      row.addEventListener('mousedown', (event) => {
        // mousedown, not click: the textarea must not lose the caret first.
        event.preventDefault();
        selected = index;
        acceptCompletion();
      });
      popup.appendChild(row);
    });
    popup.hidden = false;
    const active = popup.children[selected];
    if (active !== undefined) {
      active.scrollIntoView({ block: 'nearest' });
    }
  }

  function moveSelection(delta) {
    selected = (selected + delta + completionItems.length) % completionItems.length;
    renderCompletions();
  }

  function acceptCompletion() {
    const item = completionItems[selected];
    if (item === undefined) {
      return;
    }
    const before = input.value.slice(0, completionStart);
    const after = input.value.slice(input.selectionEnd);
    input.value = before + item + after;
    const caret = before.length + item.length;
    input.setSelectionRange(caret, caret);
    closeCompletions();
    resize();
  }

  function requestCompletions(explicit) {
    const token = ++completionToken;
    vscode.postMessage({
      type: 'complete',
      token,
      line: input.value,
      position: input.selectionEnd,
      explicit: explicit === true,
    });
  }

  function scheduleCompletions() {
    clearTimeout(completionTimer);
    completionTimer = setTimeout(() => requestCompletions(false), 150);
  }

  input.addEventListener('keydown', (event) => {
    if (completionsOpen()) {
      if (event.key === 'ArrowDown') {
        moveSelection(1);
        event.preventDefault();
        return;
      }
      if (event.key === 'ArrowUp') {
        moveSelection(-1);
        event.preventDefault();
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        acceptCompletion();
        event.preventDefault();
        return;
      }
      if (event.key === 'Escape') {
        closeCompletions();
        event.preventDefault();
        return;
      }
    }
    // Ctrl+Space asks explicitly, as in the editor.
    if (event.key === ' ' && (event.ctrlKey || event.metaKey)) {
      requestCompletions(true);
      event.preventDefault();
      return;
    }
    // Tab indents rather than leaving the console.
    if (event.key === 'Tab') {
      const start = input.selectionStart;
      const end = input.selectionEnd;
      input.value = input.value.slice(0, start) + INDENT + input.value.slice(end);
      input.setSelectionRange(start + INDENT.length, start + INDENT.length);
      resize();
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      submit();
      event.preventDefault();
      return;
    }
    // Arrows browse history only when the caret cannot travel any further,
    // so editing a recalled multi-line block still works.
    if (event.key === 'ArrowUp' && input.selectionStart === 0) {
      if (browseHistory(-1)) {
        event.preventDefault();
      }
      return;
    }
    if (event.key === 'ArrowDown' && input.selectionEnd === input.value.length) {
      if (browseHistory(1)) {
        event.preventDefault();
      }
    }
  });

  input.addEventListener('input', () => {
    resize();
    const before = input.value.slice(0, input.selectionEnd);
    // Only suggest while typing a name, an attribute or a magic.
    if (/[A-Za-z0-9_.%]$/.test(before)) {
      scheduleCompletions();
    } else {
      closeCompletions();
    }
  });

  input.addEventListener('blur', closeCompletions);

  // Clicking anywhere in the transcript should let the user keep typing,
  // unless they are selecting text to copy.
  scrollback.addEventListener('mouseup', () => {
    if ((window.getSelection()?.toString() ?? '') === '') {
      input.focus();
    }
  });

  window.addEventListener('message', (event) => {
    const message = event.data;
    switch (message.type) {
      case 'state':
        renderTabs(message.sessions);
        renderTranscript(message.transcript);
        applyStatus(message.prompt, message.busy);
        break;
      case 'sessions':
        renderTabs(message.sessions);
        applyStatus(message.prompt, message.busy);
        break;
      case 'append': {
        const stick = atBottom();
        appendEntry(message.entry, stick);
        break;
      }
      case 'completions': {
        // Ignore a reply the user has already typed past.
        if (message.token !== completionToken) {
          break;
        }
        completionStart = message.start;
        completionItems = message.items;
        selected = 0;
        if (completionItems.length === 0) {
          closeCompletions();
        } else {
          renderCompletions();
        }
        break;
      }
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
