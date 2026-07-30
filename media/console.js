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

  // Syntax highlighting for the echoed input, so the transcript reads like a
  // REPL rather than a wall of one colour. Colours come from the theme's own
  // terminal palette — the only token-ish colours exposed to a webview.
  const TOKENS = [
    ['comment', /#[^\n]*/y],
    ['string', /(?:[rbfu]{0,2})(?:'''[\s\S]*?'''|"""[\s\S]*?"""|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*")/y],
    ['number', /\b\d[\w.]*\b/y],
    ['keyword', /\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield|True|False|None|function|NULL|NA|TRUE|FALSE|repeat|next)\b/y],
    ['magic', /^\s*[%!][A-Za-z_]\w*/y],
    ['builtin', /\b(?:print|len|range|list|dict|set|tuple|str|int|float|bool|open|type|self|cat|paste|library|c)\b/y],
  ];

  function highlightInto(parent, text) {
    let index = 0;
    while (index < text.length) {
      let matched = false;
      for (const [kind, pattern] of TOKENS) {
        pattern.lastIndex = index;
        const found = pattern.exec(text);
        if (found !== null && found.index === index && found[0].length > 0) {
          const span = document.createElement('span');
          span.className = 'tok-' + kind;
          span.textContent = found[0];
          parent.appendChild(span);
          index += found[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        parent.appendChild(document.createTextNode(text[index]));
        index++;
      }
    }
  }

  function appendEntry(entry, stick) {
    const line = document.createElement('span');
    line.className = 'line-' + entry.kind;
    const text = entry.text.replace(ANSI, '');
    if (entry.kind === 'input') {
      // Keep the prompt plain, colour the code after it.
      const prompt = text.slice(0, 4);
      line.appendChild(document.createTextNode(prompt));
      highlightInto(line, text.slice(4));
    } else {
      line.textContent = text;
    }
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

  // One glyph per kind, like the editor's suggest widget. Letters rather than
  // codicons: a webview has no icon font, and a shape here would be one more
  // thing to keep in sync with the theme.
  const KIND_GLYPH = {
    function: 'ƒ',
    class: 'C',
    module: 'M',
    keyword: 'K',
    magic: '%',
    file: '⎘',
    folder: '▸',
    value: '□',
  };

  function typedPrefix() {
    return input.value.slice(completionStart, input.selectionEnd);
  }

  function renderCompletions() {
    popup.textContent = '';
    const prefix = typedPrefix().toLowerCase();
    completionItems.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = index === selected ? 'completion selected' : 'completion';

      const icon = document.createElement('span');
      icon.className = 'completion-icon kind-' + item.kind;
      icon.textContent = KIND_GLYPH[item.kind] || KIND_GLYPH.value;
      row.appendChild(icon);

      const label = document.createElement('span');
      label.className = 'completion-label';
      // Bold exactly what has been typed, as the editor does.
      if (prefix.length > 0 && item.label.toLowerCase().startsWith(prefix)) {
        const match = document.createElement('span');
        match.className = 'completion-match';
        match.textContent = item.label.slice(0, prefix.length);
        label.appendChild(match);
        label.appendChild(document.createTextNode(item.label.slice(prefix.length)));
      } else {
        label.textContent = item.label;
      }
      row.appendChild(label);

      if (item.detail) {
        const detail = document.createElement('span');
        detail.className = 'completion-detail';
        detail.textContent = item.detail;
        row.appendChild(detail);
      }

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
    input.value = before + item.label + after;
    const caret = before.length + item.label.length;
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

  // Clicking into the console makes it the session the Variables view shows,
  // the same way clicking a notebook cell hands the view back to it.
  document.addEventListener('focusin', () => vscode.postMessage({ type: 'focused' }));
  document.addEventListener('mousedown', () => vscode.postMessage({ type: 'focused' }));

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
