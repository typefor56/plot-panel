import type { Jupyter, Kernel } from '@vscode/jupyter-extension';
import * as vscode from 'vscode';
import { buildInspectCode, parseInspectReply, type ChildVariable } from './inspect';

/**
 * Thin adapter over the Jupyter extension, the only module talking to it.
 *
 * Two layers, by design (see CLAUDE.md):
 * - `jupyter.listVariables` — a stable contributed command — provides the
 *   flat list of top-level variables everywhere. It does not exist in the
 *   test host and its reply shape is not ours, so everything is try/caught
 *   and structurally validated.
 * - The Kernels API (`@vscode/jupyter-extension`, a types-only
 *   devDependency) powers child expansion by executing the inspection
 *   snippet. Jupyter publisher-gates it: access is granted under
 *   extensionMode Test and on Insiders, and denied — with an error toast —
 *   for unknown publishers on stable. The probe therefore only runs where
 *   access is possible; elsewhere expansion is reported unavailable and the
 *   view hides its chevrons, without ever nagging the user.
 */

export interface KernelVariable {
  readonly name: string;
  readonly value: string;
  readonly type: string;
  /** Eval path (root + property chain); equals the name at top level. */
  readonly expression: string;
  /** For pandas DataFrames: the text of df.info() (empty otherwise). */
  readonly summary?: string;
  readonly hasNamedChildren: boolean;
  readonly indexedChildrenCount: number;
}

function toKernelVariable(item: unknown): KernelVariable | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const outer = item as Record<string, unknown>;
  const inner = outer['variable'];
  if (typeof inner !== 'object' || inner === null) {
    return undefined;
  }
  const variable = inner as Record<string, unknown>;
  const name = variable['name'];
  if (typeof name !== 'string' || name.length === 0) {
    return undefined;
  }
  const summary = variable['summary'];
  return {
    name,
    value: typeof variable['value'] === 'string' ? variable['value'] : '',
    type: typeof variable['type'] === 'string' ? variable['type'] : '',
    expression: typeof variable['expression'] === 'string' ? variable['expression'] : name,
    hasNamedChildren: outer['hasNamedChildren'] === true,
    indexedChildrenCount:
      typeof outer['indexedChildrenCount'] === 'number' ? outer['indexedChildrenCount'] : 0,
    ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}),
  };
}

const STDOUT_MIMES = new Set(['text/plain', 'application/x.notebook.stream.stdout']);

export class JupyterVariablesSource {
  /** Cached per session; only ever computed while a kernel is live. */
  private expandVerdict: boolean | undefined;

  constructor(private readonly probeAllowed: boolean) {}

  /** Top-level variables of the notebook's kernel; [] on any failure. */
  async listVariables(notebook: vscode.Uri): Promise<readonly KernelVariable[]> {
    let raw: unknown;
    try {
      raw = await vscode.commands.executeCommand('jupyter.listVariables', notebook);
    } catch {
      // Command not found (Jupyter extension absent, e.g. in the test host)
      // or failed: an empty list, never an error.
      return [];
    }
    if (!Array.isArray(raw)) {
      return [];
    }
    const variables: KernelVariable[] = [];
    for (const item of raw) {
      const variable = toKernelVariable(item);
      if (variable !== undefined) {
        variables.push(variable);
      }
    }
    return variables;
  }

  /**
   * Whether child expansion works for this notebook. Call only when the
   * kernel is known to be live (a non-empty listVariables reply), so a
   * failed probe means denial, not a missing kernel, and caching is sound.
   */
  async canExpand(notebook: vscode.Uri): Promise<boolean> {
    if (!this.probeAllowed) {
      return false;
    }
    if (this.expandVerdict === undefined) {
      this.expandVerdict = (await this.kernelFor(notebook)) !== undefined;
    }
    return this.expandVerdict;
  }

  /** Children of one expression, via the inspection snippet; undefined on failure. */
  async listChildren(
    notebook: vscode.Uri,
    expression: string,
    token: vscode.CancellationToken,
  ): Promise<readonly ChildVariable[] | undefined> {
    const kernel = await this.kernelFor(notebook);
    if (kernel === undefined) {
      return undefined;
    }
    const decoder = new TextDecoder();
    let text = '';
    try {
      for await (const output of kernel.executeCode(buildInspectCode(expression), token)) {
        for (const item of output.items) {
          if (STDOUT_MIMES.has(item.mime)) {
            text += decoder.decode(item.data, { stream: true });
          }
        }
      }
    } catch {
      return undefined;
    }
    return parseInspectReply(text);
  }

  private async kernelFor(notebook: vscode.Uri): Promise<Kernel | undefined> {
    if (!this.probeAllowed) {
      return undefined;
    }
    try {
      const extension = vscode.extensions.getExtension<Jupyter>('ms-toolsai.jupyter');
      if (extension === undefined) {
        return undefined;
      }
      const api = await extension.activate();
      const kernel = await api.kernels.getKernel(notebook);
      if (kernel === undefined || kernel.language !== 'python') {
        return undefined;
      }
      return kernel;
    } catch {
      return undefined;
    }
  }
}
