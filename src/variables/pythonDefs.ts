/**
 * Top-level `def` / `class` extraction from Python source.
 *
 * Jupyter's introspection script drops functions, classes and modules kernel
 * side — `typesToExclude = ["module", "function", "method", "class", "type"]`
 * is hard-coded in its helper and takes no override — so the FUNCTIONS and
 * CLASSES sections can never be filled from `jupyter.listVariables`. The
 * names are however right there in the cells the user already ran, together
 * with their signatures, which is what Positron shows in those sections.
 *
 * Pure module, no vscode import. Deliberately shallow: only definitions at
 * column 0 count (a nested `def` is not a module-level name), and a
 * definition seen later replaces an earlier one of the same name.
 */

export interface PythonDefinition {
  readonly kind: 'function' | 'class';
  readonly name: string;
  /** "(a, b=1)" for a function, "(Base)" or '' for a class. */
  readonly signature: string;
}

const DEF_LINE = /^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*(?=\()/;
const CLASS_LINE = /^class\s+([A-Za-z_]\w*)\s*(?=[(:])/;
const TRIPLE_QUOTE = /"""|'''/g;

const SIGNATURE_CAP = 120;

/**
 * Read a parenthesised group starting at `start`, across as many lines as it
 * takes, ignoring parentheses inside string literals. Returns the group
 * (parentheses included) or undefined when it never closes.
 */
function readParenGroup(text: string, start: number): string | undefined {
  let depth = 0;
  let quote: string | undefined;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (quote !== undefined) {
      if (char === '\\') {
        index++;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '#') {
      // Comment: skip to the end of the line.
      const newline = text.indexOf('\n', index);
      if (newline === -1) {
        return undefined;
      }
      index = newline;
      continue;
    }
    if (char === '(') {
      depth++;
    } else if (char === ')') {
      depth--;
      if (depth === 0) {
        return text.slice(start, index + 1);
      }
    }
  }
  return undefined;
}

function tidy(signature: string): string {
  const collapsed = signature.replace(/\s+/g, ' ').trim();
  return collapsed.length > SIGNATURE_CAP
    ? `${collapsed.slice(0, SIGNATURE_CAP - 1)}…`
    : collapsed;
}

/**
 * Module-level functions and classes defined in this source, in order of
 * first appearance, each carrying the signature it was last defined with.
 */
export function parsePythonDefinitions(source: string): readonly PythonDefinition[] {
  const found = new Map<string, PythonDefinition>();
  const lines = source.split('\n');
  let offset = 0;
  let openDelimiter: string | undefined;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1;
    // Track triple-quoted blocks so a docstring showing example code at
    // column 0 does not register phantom definitions.
    const wasInside = openDelimiter !== undefined;
    TRIPLE_QUOTE.lastIndex = 0;
    for (let match = TRIPLE_QUOTE.exec(line); match !== null; match = TRIPLE_QUOTE.exec(line)) {
      if (openDelimiter === undefined) {
        openDelimiter = match[0];
      } else if (openDelimiter === match[0]) {
        openDelimiter = undefined;
      }
    }
    if (wasInside) {
      continue;
    }

    const def = DEF_LINE.exec(line);
    if (def?.[1] !== undefined) {
      const group = readParenGroup(source, lineStart + def[0].length);
      found.set(def[1], {
        kind: 'function',
        name: def[1],
        signature: group === undefined ? '()' : tidy(group),
      });
      continue;
    }
    const cls = CLASS_LINE.exec(line);
    if (cls?.[1] !== undefined) {
      const rest = line.slice(cls[0].length);
      const group = rest.startsWith('(')
        ? readParenGroup(source, lineStart + cls[0].length)
        : undefined;
      found.set(cls[1], {
        kind: 'class',
        name: cls[1],
        signature: group === undefined ? '' : tidy(group),
      });
    }
  }
  return [...found.values()];
}
