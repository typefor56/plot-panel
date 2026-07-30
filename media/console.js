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

  /** Submitted lines, oldest first; browsed with the arrow keys. */
  const history = [];
  let historyIndex = 0;
  /** Text being edited when the user started browsing history. */
  let draft = '';

  function atBottom() {
    return scrollback.scrollHeight - scrollback.scrollTop - scrollback.clientHeight < 24;
  }

  function appendEntry(entry, stick) {
    const line = document.createElement('span');
    line.className = 'line-' + entry.kind;
    line.textContent = entry.text;
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

  function renderTabs(sessions) {
    tabs.textContent = '';
    for (const session of sessions) {
      tabs.appendChild(makeTab(session));
    }
    const add = document.createElement('button');
    add.id = 'new-session';
    add.type = 'button';
    add.textContent = '+';
    add.title = 'New Python console';
    add.setAttribute('aria-label', 'New Python console');
    add.addEventListener('click', () => {
      vscode.postMessage({ type: 'new' });
      input.focus();
    });
    tabs.appendChild(add);
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

  input.addEventListener('keydown', (event) => {
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

  input.addEventListener('input', resize);

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
    }
  });

  vscode.postMessage({ type: 'ready' });
})();
