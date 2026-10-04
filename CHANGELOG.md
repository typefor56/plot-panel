# Changelog

## 0.2.2

- With a notebook Copilot Chat has edited, a Run All no longer adds every
  figure twice under two interleaved runs, and the variables view no longer
  drops to FUNCTIONS and CLASSES until the notebook is scrolled.

## 0.2.1

- No default keys for clearing: Ctrl+L and Ctrl+Shift+L keep their editor
  meaning. Bind **Clear Plot History** and **Clear Plot History and
  Variables** in Keyboard Shortcuts if you want keys (the README shows how).

## 0.2.0

- The plot history reads chronologically: every run adds its figures again,
  even byte-identical ones (stored once on disk), under a "Run all N" or
  "Run y" marker.
- The variables view shows name, value, type and size: values for constants
  only (numpy scalars unwrapped), sizes in numpy's shape notation, a second
  resizable divider before the type, the full type on hover, and an
  always-visible Data Viewer button.
- Clear Variables also empties FUNCTIONS and CLASSES, and a notebook just
  reopened no longer lists definitions nothing has run.
- A Clear Plot History and Variables command, alongside Clear Plot History.
- The views open in the secondary sidebar, next to Chat. Requires VS Code
  1.106.
- Rows of the variables view no longer stay unpainted after a Run All.

## 0.1.0

First release.

- A plots pane that captures every figure from notebooks and the Interactive
  Window, keeps a per-project history across restarts, and marks where each run
  started.
- A variables view with two columns, a draggable divider, grouping and sorting,
  expansion into preview tables, and a button to open data in a viewer.
- An interactive Python or R console in the bottom panel, with completions from
  the live session, IPython magics when available, and several sessions at once.
