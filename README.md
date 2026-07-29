# Plot Panel

A permanent plot pane for VS Code, in the spirit of RStudio and Positron.

Plot Panel automatically captures every figure produced by Jupyter kernels —
from notebooks **and** from the Interactive Window (`# %%` cells) — and shows
them in a dedicated view: the current figure on top, resized to fit without
distortion, and a clickable thumbnail strip of the whole session history below.
No clicking on outputs, no lost figures: iterate on your model, and glance back
at the plot from three runs ago.

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

Positron shows Variables on top and Plots below, in the right-hand pane. VS
Code cannot place views there programmatically, but both views are movable by
hand, once, and the layout is remembered:

1. Open the secondary sidebar (`Ctrl+Alt+B` / `⌥⌘B`, or *View → Appearance →
   Secondary Side Bar*).
2. Drag the **Plots** icon from the activity bar into the secondary sidebar.
3. Run a cell in the Interactive Window, open the **Jupyter** panel's
   **Variables** view (*Jupyter: Focus on Variables View*), and drag it into
   the secondary sidebar, above Plots.

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
| `Plot Panel: Export All Plots…` | title-bar `…` menu; writes the whole history to a chosen folder as numbered files in their original formats |
| `Plot Panel: Clear Plot History` | title-bar `…` menu |

## Known limitations

- **Interactive widget outputs have no static image.** Figures rendered through
  plotly, bokeh, ipywidgets or similar widget front-ends never reach the
  notebook as an image; Plot Panel shows an explicit message instead of
  capturing them. Use a static backend (e.g. matplotlib, or plotly's
  `fig.show(renderer="png")`) if you want them in the history.
- **Identical figures are deduplicated.** The history is keyed by image
  content: re-running code that produces a byte-identical figure selects the
  existing entry instead of adding a duplicate.
- **The view cannot move itself to the secondary sidebar.** The VS Code API has
  no way to place a view there; the one-time drag described above is required.
- **Figures produced before the extension host finished starting** (very early
  in a session) are not captured; capture is event-based, not retroactive over
  pre-existing outputs.
- **Copying focuses the Plots view.** The stable extension API only offers a
  text clipboard, so the image is written by the view itself through the
  browser clipboard, which requires a focused document. If the environment
  denies the clipboard permission, the command reports an explicit error
  rather than failing silently.
