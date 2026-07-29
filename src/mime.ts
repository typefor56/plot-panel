/**
 * MIME selection for notebook cell outputs.
 *
 * A kernel usually offers several representations of the same output
 * (e.g. image/png + text/plain, or image/svg+xml + image/png). We pick the
 * richest static image, preferring vector over bitmap. Interactive widget
 * outputs (plotly, bokeh, ipywidgets…) carry no static image at all and are
 * detected separately so the UI can say so explicitly.
 */

/** Structural subset of vscode.NotebookCellOutputItem, kept vscode-free for unit testing. */
export interface OutputItemLike {
  readonly mime: string;
  readonly data: Uint8Array;
}

/** Ordered by preference: vector first, then bitmaps by fidelity. */
const IMAGE_MIME_PREFERENCE: readonly string[] = [
  'image/svg+xml',
  'image/png',
  'image/webp',
  'image/jpeg',
  'image/gif',
  'image/bmp',
];

/** Outputs rendered by an interactive widget: no static image to capture. */
const WIDGET_MIME_PREFIXES: readonly string[] = [
  'application/vnd.plotly',
  'application/vnd.bokehjs',
  'application/vnd.jupyter.widget-view',
  'application/vnd.holoviews',
  'application/vnd.vega',
  'application/vnd.vegalite',
];

/** Pick the best static image representation among the output items, if any. */
export function pickImageItem(items: readonly OutputItemLike[]): OutputItemLike | undefined {
  for (const mime of IMAGE_MIME_PREFERENCE) {
    const found = items.find((item) => item.mime === mime);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

/** Return the widget MIME type if the output is an interactive widget, else undefined. */
export function findWidgetMime(items: readonly OutputItemLike[]): string | undefined {
  const found = items.find((item) =>
    WIDGET_MIME_PREFIXES.some((prefix) => item.mime.startsWith(prefix)),
  );
  return found?.mime;
}

/** File extension (without dot) for saving a captured image in its original format. */
export function extensionForMime(mime: string): string {
  switch (mime) {
    case 'image/svg+xml':
      return 'svg';
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/jpeg':
      return 'jpg';
    case 'image/gif':
      return 'gif';
    case 'image/bmp':
      return 'bmp';
    default:
      return 'bin';
  }
}
