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

## The Variables view

After each execution finishes (and on demand via the refresh button), the
view lists the kernel's top-level variables — Python kernels only. It is
named just "Variables" to stay distinguishable from the Jupyter extension's
own view. The title bar offers two dropdowns: **Group Variables By** — Kind
(the Positron categories: **DATA** for pandas/polars tables, **VALUES** for
everything else including numpy arrays, **FUNCTIONS**, **CLASSES**) or Size
(LARGE ≥ 100k elements / MEDIUM ≥ 1k / SMALL) — and **Sort Variables By** —
Name, Size, or Recent (variables that appeared or changed since the previous
refresh bubble up; changes are detected by comparing snapshots, so the first
listing has no history). Both persist across restarts; native menus cannot
mark the active choice. Note that `jupyter.listVariables` excludes
functions, classes and modules kernel-side, so those sections stay empty
with the stable data source.

**Always two columns**: name | value, plus a small right-aligned type hint.
DataFrames show their shape (`[444448 rows x 24 columns]`), Series and
collections an elided `[begin, …, end]` preview with the element count in
the hint (`list (1000)`), long reprs are cut hard. The filter field narrows
by name; section headers collapse.

Expansion keeps the two-column rule at every level:

- **Everywhere (stable included)**: a DataFrame expands into its columns
  (non-null count and dtype from `df.info()`), and each column expands again
  into an index | value table; a Series expands into its index | value
  pairs; lists, tuples, sets and arrays into position | item; dicts into
  key | value. These tables are previews parsed from what pandas/numpy print
  (typically the head and tail around a centered `⋯` row) — for full data,
  use the grid button. pandas omits the `df.info()` table beyond 100 columns
  and wraps very wide reprs, in which case those levels stay unexpandable.
- **Full depth with live values** requires the Jupyter extension's Kernels
  API, reserved for allow-listed publishers on stable VS Code; it works on
  Insiders and in the test host, where expansion runs a real inspection
  snippet on the kernel instead of parsing reprs.

**Open in Data Viewer**: rows holding a DataFrame, Series, ndarray, list or
dict (including DataFrame columns) show a grid button on hover that opens
the variable full-size via the Jupyter extension's data-viewer delegation —
with Data Wrangler installed, that is where it opens. Requires a trusted
workspace, the notebook open, and a live kernel; if no viewer extension is
installed, Jupyter itself offers to find one.

**Performance**: refreshing asks the kernel to describe every variable
(that is Jupyter's own introspection script running on the kernel, with
DataFrame summaries cached per execution). The view only refreshes when it
is visible and only when an execution ends, coalescing bursts into a single
fetch. If a huge namespace still makes it noticeable, set
`plotPanel.variablesAutoRefresh` to `false` and use the refresh button.

## Settings

| Setting | Default | Effect |
| --- | --- | --- |
| `plotPanel.autoReveal` | `true` | Reveal the Plots view (without stealing focus) when a new figure arrives. |
| `plotPanel.followLatest` | `true` | Always select the most recent figure. When disabled, the current selection is kept while new figures accumulate. |
| `plotPanel.historyLimit` | `50` | Maximum number of figures kept; the oldest are evicted first. |
| `plotPanel.variablesAutoRefresh` | `true` | Refresh the Jupyter Variables view when a cell finishes executing. Disable on heavy notebooks to refresh only with the button. |

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
| `Plot Panel: Refresh Variables` | title bar of the Variables view |
| `Plot Panel: Group Variables by Kind / Size` | Group Variables By dropdown |
| `Plot Panel: Sort Variables by Name / Size / Recently Changed` | Sort Variables By dropdown |

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
- **Variables are Python-only, and deep expansion needs the Kernels API.**
  Other kernels show nothing; on stable VS Code the publisher-gated Jupyter
  Kernels API limits expansion to DataFrame columns (see above), and
  functions/classes are filtered out by `jupyter.listVariables` itself.
- **Figures produced before the extension host finished starting** (very early
  in a session) are not captured; capture is event-based, not retroactive over
  pre-existing outputs.
- **Copying focuses the Plots view.** The stable extension API only offers a
  text clipboard, so the image is written by the view itself through the
  browser clipboard, which requires a focused document. If the environment
  denies the clipboard permission, the command reports an explicit error
  rather than failing silently.
