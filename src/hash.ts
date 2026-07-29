import { createHash } from 'node:crypto';

/**
 * Content identity of a captured output, used for deduplication.
 * Hashing mime + bytes (never an API-provided output id) is what absorbs the
 * repeated output-change events VS Code fires for a single execution.
 */
export function contentId(mime: string, data: Uint8Array): string {
  return createHash('sha256').update(mime).update(data).digest('hex');
}
