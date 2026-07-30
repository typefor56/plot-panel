# Where this project stands

Written 2026-07-31, after the sessions that built the variables view, the
console and the run markers. `CLAUDE.md` holds the engineering decisions and
the hard constraints; this file is the shorter answer to "what is this, what
works, what is left".

## What it is

A VS Code extension reproducing the layout a data science IDE gives you: a
plots pane with history, a variables explorer, and an interactive console. It
targets Python notebooks, plus R in the console.

Identity: publisher `for56`, repository `typefor56/plot-panel-forvscode`,
MIT, version 0.1.0. Zero runtime dependencies, no network, no telemetry.

## The three pieces

**Plots.** Captures every image output from notebooks and the Interactive
Window, keyed by content hash so duplicates are stored once. History is
per project, survives restarts, and the thumbnail strip marks where each run
began. Runs are inferred from the cell index and execution count of each
capture, because no stable API reports "the user pressed Run All".

**Variables.** Lists the kernel's variables in two columns with a draggable
divider, groups by kind or size, sorts by name, size or recency, and marks
what a run changed. Rows expand into preview tables. Where the data comes from
decides how deep that goes, which is the single most important thing to
understand about this project:

- A **console session** is a process the extension owns, so children are read
  from live objects at any depth, and functions and classes are real.
- A **notebook kernel** can only be described through `jupyter.listVariables`,
  which returns truncated text. Nesting collapses past two levels and every
  nested item is cut at 128 characters, both measured against real debugpy
  output. Tables are parsed out of those reprs; functions and classes come from
  the source of the cells that ran.

The reason for the split: running code in a notebook kernel and reading the
result back needs the Jupyter Kernels API, which is restricted to allow-listed
publishers. That single restriction explains most of the design.

**Console.** A Python or R prompt in the bottom panel. Each language has its
own driver script speaking one line-framed JSON protocol, so the host code does
not know which it is talking to. Python uses IPython when available, which is
what makes magics work; R is base R only, with the JSON hand-rolled since no
package can be assumed installed.

## What has been verified

126 tests in a real extension host, including suites driving both drivers
against live interpreters. `tsc` strict with no `any`, an empty production
dependency tree, and the packaged `.vsix` carries both drivers.

Two code-injection paths were found while auditing for publication and closed:
a list or column name pasted unescaped into an R expression, and completion
evaluating whatever preceded the last dot. Both have regression checks in the
session log; re-run them by feeding the drivers directly if you touch that code.

## Known limits, stated once

The console cannot see a notebook's variables. Deep expansion in a notebook is
bounded by truncated reprs. Imported classes never appear in a notebook's
CLASSES section, because the kernel filters classes out and the source cannot
tell an imported class from an imported function. Variables cannot refresh
while a cell is still running: the introspection queues behind it. Widget
outputs (plotly, bokeh, ipywidgets) have no static image to capture.

Two dependencies are fragile by nature and worth re-checking after a Jupyter
update: `jupyter.listVariables` and `jupyter.showDataViewer`, both internal
commands whose payloads were established by reading the shipped bundles.

## Left to do

Publishing needs a GitHub repository at `typefor56/plot-panel-forvscode`,
pushed public, because the readme points at its screenshots by absolute url and
the Marketplace does not resolve relative paths. Then a publisher account for
`for56` and an Azure DevOps token, and `vsce publish`.

The git history was rewritten on 2026-07-31 to carry a single author and to
drop the Positron reference screenshots that had been committed early on. A
backup of the pre-rewrite repository sits next to this one and can go once
you are satisfied.
