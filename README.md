# Plot Panel

A permanent plot pane for VS Code, in the spirit of RStudio and Positron.

Plot Panel automatically captures every figure produced by Jupyter kernels —
from notebooks **and** from the Interactive Window (`# %%` cells) — and shows
them in a dedicated view: the current figure on top, resized to fit without
distortion, and a clickable thumbnail strip of the whole session history below.
No clicking on outputs, no lost figures: iterate on your model, and glance back
at the plot from three runs ago.

Around that core, the extension recreates the rest of the Positron experience:
a Positron-style toolbar (zoom presets, sizing policies, a dark filter for
bright figures), plots and a full gallery openable in editor tabs or floating
windows, actions on the code that produced a plot (copy / reveal / run again),
and a **Jupyter Variables** view that groups the kernel's variables into
DATA / VALUES / FUNCTIONS / CLASSES sections with a filter field.

## How it differs from the built-in Plot Viewer

The Jupyter extension's Plot Viewer is passive: you must double-click an output
to open it, it only offers previous/next arrows without any overview, and it
lives in an editor tab that the next opened file replaces. Plot Panel is:

- **automatic** — figures appear as they are produced, without any action;
- **permanent** — it is a view, not an editor tab; dock it in the secondary
  sidebar and it stays there;
- **navigable** — the thumbnail strip shows the whole session at a glance, and
  clicking a thumbnail (or using the arrow keys / title-bar buttons) brings any
  earlier figure back;
- **persistent** — the history survives restarting VS Code. It is stored in
  the extension's global storage (as plain image files plus an index, never in
  `workspaceState`), reduced thumbnails included, and pruned automatically
  when entries are evicted or cleared.

## Building and installing

```sh
npm install          # dev dependencies only; the extension itself has none
npm run compile
npm test             # runs the suites in a real VS Code extension host
npm run package      # produces plot-panel-<version>.vsix
```

Install the `.vsix` with `code --install-extension plot-panel-*.vsix`, or from
the Extensions view: `…` menu → *Install from VSIX…*.

## Recreating the Positron layout

Positron shows Variables on top and Plots below, in the right-hand pane. The
extension ships both views in one container, Variables above Plots. VS Code
cannot place a view container in the secondary sidebar programmatically, but
it is movable by hand, once, and the layout is remembered:

1. Open the secondary sidebar (`Ctrl+Alt+B` / `⌥⌘B`, or *View → Appearance →
   Secondary Side Bar*).
2. Drag the **Plots** icon from the activity bar into the secondary sidebar.
   Both views come along; resize them against each other as you like.

## The toolbar

The Plots view title bar mirrors Positron's toolbar: previous/next, save,
copy, a **Zoom** dropdown (Fit, 50 %, 75 %, 100 %, 200 %), an **Open Plot
In** dropdown, and the trash can that clears the history. Zoom presets and
sizing policies are one setting — the last selection wins — kept across
restarts. Native VS Code menus cannot show a check mark on the active level;
the rendered figure is the source of truth.

**Open Plot In** offers: an editor tab, an editor tab to the side, a floating
window, or the **Plots Gallery** — the same history in a full-size editor tab
or its own window. The gallery's title bar adds the **Sizing Policy** dropdown
(Fit, Fill Width, Fill Height, Actual Size), the **dark filter** toggle (a CSS
invert filter that makes bright figures comfortable in dark themes, applied to
every plot surface), and the **Plot Code** dropdown.

**Plot Code** acts on the code captured with the current plot: *Copy Code*,
*Reveal Code in Source* (jumps to the notebook cell, or to the `# %%` block in
the original `.py` file for Interactive Window plots), and *Run Code Again*
(re-executes the originating cell if the notebook is still open; failures are
reported explicitly). Plots restored from a history recorded before this
feature carry no code, and the actions are greyed out.

## The Jupyter Variables view

After each execution (and on demand via the refresh button), the view lists
the kernel's top-level variables — Python kernels only — grouped like
Positron: **DATA** (DataFrame, Series, Index, ndarray), **FUNCTIONS**
(callables), **CLASSES** (class definitions), **VALUES** (everything else).
Two main columns, name and value, plus a right-aligned type hint; the filter
field narrows by name; section headers collapse.

Expanding a row into its children (the columns of a DataFrame, the keys of a
dict, the attributes of an object) requires the Jupyter extension's Kernels
API, which is currently reserved for allow-listed publishers on stable VS
Code; it works on Insiders and in the test host. Where the API is denied the
chevrons are simply hidden and the flat list remains fully functional.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `plotPanel.autoReveal` | `true` | Reveal the Plots view (without stealing focus) when a new figure arrives. |
| `plotPanel.followLatest` | `true` | Always select the most recent figure. When disabled, the current selection is kept while new figures accumulate. |
| `plotPanel.historyLimit` | `50` | Maximum number of figures kept; the oldest are evicted first. |

### A note on `jupyter.generateSVGPlots`

By default, matplotlib emits PNG. With the Jupyter extension setting
`jupyter.generateSVGPlots` enabled, kernels also emit SVG, and Plot Panel then
prefers the vector representation — crisper zooming, usually smaller files.

## Commands

| Command | Where |
| --- | --- |
| `Plot Panel: Previous Plot` / `Next Plot` | title bar of the view, or ← / → when the view is focused |
| `Plot Panel: Save Plot As…` | title bar; writes the figure byte-for-byte in its original format |
| `Plot Panel: Copy Plot` | title bar; copies the current figure to the clipboard as PNG |
| `Plot Panel: Zoom to Fit / 50% / 75% / 100% / 200%` | Zoom dropdown on every plot surface |
| `Plot Panel: Size Plot to Fill Width / Fill Height / Actual Size` | Sizing Policy dropdown on the editor panels |
| `Plot Panel: Toggle Dark Filter on Plots` | editor panels' title bars, view `…` menu |
| `Plot Panel: Open Plot in Editor Tab / to the Side / New Window` | Open Plot In dropdown |
| `Plot Panel: Open Plots Gallery in Editor Tab / New Window` | Open Plot In dropdown |
| `Plot Panel: Copy / Reveal / Run Plot Code` | Plot Code dropdown on the editor panels |
| `Plot Panel: Export All Plots…` | title-bar `…` menu; writes the whole history to a chosen folder as numbered files in their original formats |
| `Plot Panel: Clear Plot History` | title bar (trash can) |
| `Plot Panel: Refresh Jupyter Variables` | title bar of the Variables view |

On a pinned single-plot tab, save/copy/code act on that plot; everywhere else
they act on the gallery selection.

## Known limitations

- **Interactive widget outputs have no static image.** Figures rendered through
  plotly, bokeh, ipywidgets or similar widget front-ends never reach the
  notebook as an image; Plot Panel shows an explicit message instead of
  capturing them. Use a static backend (e.g. matplotlib, or plotly's
  `fig.show(renderer="png")`) if you want them in the history.
- **Identical figures are deduplicated.** The history is keyed by image
  content: re-running code that produces a byte-identical figure selects the
  existing entry instead of adding a duplicate — and keeps the first
  capture's code metadata, since only the content identifies an entry.
- **The views cannot move themselves to the secondary sidebar.** The VS Code
  API has no way to place a view there; the one-time drag described above is
  required.
- **Variables are Python-only, and child expansion needs the Kernels API.**
  Other kernels show nothing, and on stable VS Code the publisher-gated
  Jupyter Kernels API keeps the rows unexpandable (see above).
- **Figures produced before the extension host finished starting** (very early
  in a session) are not captured; capture is event-based, not retroactive over
  pre-existing outputs.
- **Copying focuses the Plots view.** The stable extension API only offers a
  text clipboard, so the image is written by the view itself through the
  browser clipboard, which requires a focused document. If the environment
  denies the clipboard permission, the command reports an explicit error
  rather than failing silently.
