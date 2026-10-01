# Plot Panel

A plots pane, a variables explorer and an interactive console for VS Code, so
notebook work feels less like scrolling through a log.

If you use notebooks for data work, you know the pattern: you plot something,
run three more cells, and now the figure you wanted is somewhere above, between
two stack traces. Plot Panel keeps every figure your kernel produces in one
pane, shows your variables in another, and gives you a real Python or R prompt
at the bottom of the window.

![The three panes in a working session](https://raw.githubusercontent.com/typefor56/plot-panel/HEAD/docs/screenshots/plot_panel_big_picture.png)

## The plots pane

Figures land there by themselves, from notebooks and from the Interactive
Window. The current one is shown large, the whole session sits underneath as
thumbnails, and the strip marks where each run started so you can find the
figures from a given run without counting.

The history survives a restart, and each project keeps its own. Open another
repository and you get a clean strip; come back and your figures are still
there.

![Plots and variables in the secondary sidebar](https://raw.githubusercontent.com/typefor56/plot-panel/HEAD/docs/screenshots/plot_panel_ex1.png)

The title bar carries the usual things: previous and next, save, copy, zoom
presets, and a menu to open a plot in an editor tab or a floating window. There
is a dark filter for figures that are too bright against a dark theme, and a
Plot Code menu that copies the code behind a figure, jumps to the cell that made
it, or runs it again.

## The variables view

After a cell finishes, the view lists what the kernel holds. Two columns, name
and value, with a small type on the right. The line between them is a real
divider you can drag, and it sizes itself to your longest variable name to start
with.

Rows open. A DataFrame opens into its columns, a column into its values, a list
into its items, a dict into its keys. Values are shown the way you would want to
read them: a frame as `[444448 rows x 24 columns]`, a list as `[5, 7, 2, …, 9,
1]` with its length beside it. Anything a data viewer can display gets a grid
button on hover, which hands it to Data Wrangler if you have that installed.

You can group by kind or by size, sort by name, size or recency, and filter by
name. Variables that changed during the last run are marked, so a long Run All
does not leave you comparing lists by eye.

## The console

![The console in the bottom panel](https://raw.githubusercontent.com/typefor56/plot-panel/HEAD/docs/screenshots/console_panel.png)

A Python prompt in the bottom panel, next to the terminal. Enter runs, Shift and
Enter add a line, Tab indents, and the arrows walk back through what you typed.
Completions come from the session itself, so `df.` lists the columns that frame
actually has rather than a guess from static analysis.

![Completions offered from the live session](https://raw.githubusercontent.com/typefor56/plot-panel/HEAD/docs/screenshots/console_autocompletion.png)

If IPython is available, magics work, including `%run` on a notebook file. You
can open several sessions, restart one, interrupt a runaway loop, and choose
which interpreter to start: any environment the Python extension knows about, or
R if `Rscript` is on your path.

Running something in a console makes the variables view follow it, and clicking
back into a notebook hands the view back.

## Requirements

The Jupyter extension, for notebooks and their kernels. The Python extension is
optional and used to find your interpreters. R sessions need `Rscript`. IPython,
if present in the environment you start, is what makes magics work.

Nothing is bundled: the extension has no runtime dependencies, makes no network
requests, and collects nothing.

## Getting the side-by-side layout

The two views ship in one container, Variables above Plots, that opens in the
secondary sidebar as a tab next to Chat (`Ctrl+Alt+B`, or View, Appearance,
Secondary Side Bar, if it is hidden). This needs VS Code 1.106 or later. You can
still drag the container anywhere else; VS Code remembers where you put it.

## What it cannot do

Worth knowing before you rely on it.

The console runs its own interpreter, so it does not see the variables in your
notebook's kernel. Running code inside a notebook kernel and reading the result
back is reserved by the Jupyter extension to a short list of publishers. That
restriction is also why expansion in a notebook is limited: the view only gets
truncated text descriptions, which stop nesting after two levels and cut every
nested item at 128 characters. A DataFrame inside a list shows its shape but
usually will not open further. A console session has no such ceiling, because
the process belongs to the extension.

For the same reason, functions and classes in a notebook are read from the
source of the cells you ran rather than from live objects, so what you see is
their signature. Imported classes do not show up at all. A console lists them
properly.

Figures drawn by plotly, bokeh or ipywidgets never reach the notebook as an
image, so there is nothing to capture and the pane says so instead of going
quiet. Identical figures are stored once: re-running code that produces exactly
the same image selects the existing entry rather than adding a copy.

Variables cannot appear while a cell is still running. The introspection that
lists them runs on the kernel, so it waits its turn behind your code.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `plotPanel.autoReveal` | `true` | Reveal the Plots view when a figure arrives, without taking focus. |
| `plotPanel.followLatest` | `true` | Select the newest figure. Turn off to keep your place while figures accumulate. |
| `plotPanel.historyLimit` | `50` | How many figures to keep. The oldest go first. |
| `plotPanel.variablesAutoRefresh` | `true` | Refresh the variables when a cell finishes. Turn off on heavy notebooks and use the refresh button. |

With `jupyter.generateSVGPlots` enabled, kernels also emit SVG and the pane
prefers it: crisper when zoomed, usually smaller on disk.

If your figures come out with a dark background, that is
`jupyter.themeMatplotlibPlots`, a Jupyter setting that repaints matplotlib to
match your theme. Set it to `false` for white figures.

## Commands

Everything is on the title bars, and all of it is in the command palette under
`Plot Panel`. The ones worth a keybinding are Send Selection to Console
(`Ctrl+Enter` in a Python file), Previous and Next Plot (left and right arrows
when the pane has focus), and Refresh Variables.

In a notebook or Plot Panel's views, `Ctrl+L` clears the plot history and
`Ctrl+Shift+L` clears both the plot history and the variables (a notebook
kernel restart, confirmed first). Elsewhere both keys keep their editor
meaning. VSCodeVim binds `Ctrl+L` too: if it wins inside cells, set
`"vim.handleKeys": { "<C-l>": false }` or rebind Clear Plot History in your
own keybindings.

## Trademarks

An independent project, not affiliated with, endorsed by or sponsored by Posit
Software, PBC or Microsoft. Positron and RStudio are trademarks of Posit
Software, PBC, named here only to describe the layout this extension reproduces.
No Positron source code was consulted or used: the implementation is original,
and the behaviour it matches was derived from public behaviour and from the
VS Code and Jupyter extension APIs.
