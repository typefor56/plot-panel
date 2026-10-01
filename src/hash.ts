import { createHash } from 'node:crypto';

/**
 * Content identity of a captured output: names the image file on disk.
 * Hashing mime + bytes (never an API-provided output id) is what absorbs the
 * repeated output-change events VS Code fires for a single execution.
 */
export function contentId(mime: string, data: Uint8Array): string {
  return createHash('sha256').update(mime).update(data).digest('hex');
}

/**
 * Identity of one capture: the same content from the same cell in the same
 * run is the same figure (VS Code re-fires output events within one
 * execution); another run of that cell is a new figure, even byte-identical.
 */
export function captureId(
  contentHash: string,
  notebookUri: string,
  cellIndex: number,
  run: number | undefined,
): string {
  return createHash('sha256')
    .update(`${contentHash}\0${notebookUri}\0${cellIndex}\0${run ?? ''}`)
    .digest('hex');
}
