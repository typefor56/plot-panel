# Changelog

## 0.2.6

- A Run All is no longer slowed down by the Variables view: the list now
  waits until no cell is running instead of asking the kernel between two
  cells. Measured on a 21-cell notebook with 9 figures: 9.6 s before,
  6.5 s now, 6.1 to 6.5 s without the extension. The list therefore
  updates once at the end of a Run All rather than after each cell.

## 0.2.5

- A Run All also stays one run when VS Code itself is slow to queue the
  cells (seen right after startup, where 0.2.4 still cut it into several).
- Two cells run by hand one right after the other are two runs, however
  quick.
- The "Plot Panel" log channel records what the run grouping receives.

## 0.2.4

- A Run All stays one run in the plot strip when the kernel takes its time
  between two cells (busy, or just restarted), instead of being cut in two.

## 0.2.3

- On a first Run All, every variable it created is highlighted, not only
  those from the later cells. Same for the first statement of a console.

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
