import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { ChildVariable } from '../variables/inspect';
import type { KernelVariable } from '../variables/jupyterApi';
import type { Runtime } from './interpreter';

/**
 * One interactive Python session: a child process running
 * media/console_driver.py, framed as one JSON object per line each way.
 *
 * The session owns the scrollback. A webview cannot receive messages while it
 * is hidden, and ours is a stateless projection re-hydrated on every ready
 * handshake, so the transcript has to live here.
 */

export type SessionState = 'starting' | 'idle' | 'busy' | 'exited';

export type TranscriptKind = 'input' | 'out' | 'err' | 'result' | 'notice';

export interface TranscriptEntry {
  readonly kind: TranscriptKind;
  readonly text: string;
}

/** Lines kept per session; the oldest are dropped. */
const SCROLLBACK_LIMIT = 5000;

interface PendingRequest {
  readonly resolve: (frame: Record<string, unknown>) => void;
}

export interface CompletionItem {
  readonly label: string;
  /** function | class | module | value | keyword | magic | file | folder */
  readonly kind: string;
  /** Type name shown to the right, as the editor's suggest widget does. */
  readonly detail: string;
}

export interface Completions {
  /** Index in the line where the replaced token starts. */
  readonly start: number;
  readonly items: readonly CompletionItem[];
}

function toCompletionItem(value: unknown): CompletionItem | undefined {
  if (typeof value === 'string') {
    return { label: value, kind: 'value', detail: '' };
  }
  if (!isRecord(value) || typeof value['label'] !== 'string') {
    return undefined;
  }
  return {
    label: value['label'],
    kind: typeof value['kind'] === 'string' ? value['kind'] : 'value',
    detail: typeof value['detail'] === 'string' ? value['detail'] : '',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toKernelVariable(item: unknown): KernelVariable | undefined {
  if (!isRecord(item) || typeof item['name'] !== 'string') {
    return undefined;
  }
  return {
    name: item['name'],
    value: typeof item['value'] === 'string' ? item['value'] : '',
    type: typeof item['type'] === 'string' ? item['type'] : '',
    expression: typeof item['expression'] === 'string' ? item['expression'] : item['name'],
    hasNamedChildren: item['hasNamedChildren'] === true,
    indexedChildrenCount:
      typeof item['indexedChildrenCount'] === 'number' ? item['indexedChildrenCount'] : 0,
  };
}

function toChildVariable(item: unknown): ChildVariable | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const { name, expression, type, value, hasChildren } = item;
  if (
    typeof name !== 'string' ||
    typeof expression !== 'string' ||
    typeof type !== 'string' ||
    typeof value !== 'string'
  ) {
    return undefined;
  }
  return { name, expression, type, value, hasChildren: hasChildren === true };
}

export class ConsoleSession {
  private child: ChildProcessWithoutNullStreams | undefined;
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private entries: TranscriptEntry[] = [];
  private currentState: SessionState = 'starting';
  private continuation = false;
  private interpreterLabel = '';
  private readonly changeListeners = new Set<() => void>();
  private readonly appendListeners = new Set<(entry: TranscriptEntry) => void>();

  constructor(
    readonly id: number,
    readonly runtime: Runtime,
    private readonly driverPath: string,
    private readonly cwd: string | undefined,
  ) {}

  /** Language name plus the version the driver reported once it started. */
  get label(): string {
    const language = this.runtime.language === 'r' ? 'R' : 'Python';
    return this.interpreterLabel.length > 0
      ? `${language} ${this.interpreterLabel}`
      : this.runtime.label;
  }

  get state(): SessionState {
    return this.currentState;
  }

  /** True while the driver is waiting for the rest of a compound statement. */
  get needsMoreInput(): boolean {
    return this.continuation;
  }

  get transcript(): readonly TranscriptEntry[] {
    return this.entries;
  }

  onDidChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  onDidAppend(listener: (entry: TranscriptEntry) => void): () => void {
    this.appendListeners.add(listener);
    return () => this.appendListeners.delete(listener);
  }

  start(): void {
    this.setState('starting');
    const args =
      this.runtime.language === 'r'
        ? ['--vanilla', this.driverPath]
        : ['-u', this.driverPath];
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(this.runtime.command, args, {
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        env: {
          ...process.env,
          PYTHONIOENCODING: 'utf-8',
          // No display is attached to this process: a plotting library that
          // reached for a window backend would hang or fail outright.
          MPLBACKEND: 'Agg',
        },
      });
    } catch {
      this.append({ kind: 'err', text: `Could not start ${this.runtime.command}.\n` });
      this.setState('exited');
      return;
    }
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => this.onStdout(chunk));
    // Anything on stderr comes from the interpreter itself: once the driver
    // is up it reroutes sys.stderr into the frame protocol.
    child.stderr.on('data', (chunk: string) => this.append({ kind: 'err', text: chunk }));
    child.on('error', (error: Error) => {
      this.append({ kind: 'err', text: `${error.message}\n` });
      this.setState('exited');
    });
    child.on('exit', (code) => {
      this.child = undefined;
      this.failPending();
      if (this.currentState !== 'exited') {
        this.append({ kind: 'notice', text: `Session exited (code ${code ?? 0}).\n` });
        this.setState('exited');
      }
    });
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) {
        this.onFrame(line);
      }
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private onFrame(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      // Not ours: a stray print from a library writing to fd 1 directly.
      this.append({ kind: 'out', text: `${line}\n` });
      return;
    }
    if (!isRecord(frame)) {
      return;
    }
    const kind = frame['t'];
    switch (kind) {
      case 'ready': {
        this.interpreterLabel = typeof frame['version'] === 'string' ? frame['version'] : '';
        const executable = typeof frame['executable'] === 'string' ? frame['executable'] : '';
        const language = this.runtime.language === 'r' ? 'R' : 'Python';
        // A banner, as any REPL opens with: which interpreter is answering
        // matters as soon as more than one can be started.
        this.append({
          kind: 'notice',
          text:
            `${language} ${this.interpreterLabel}` +
            `${executable.length > 0 ? ` — ${executable}` : ''}` +
            `${frame['magics'] === true ? ' — IPython magics available' : ''}\n`,
        });
        this.continuation = false;
        this.setState('idle');
        break;
      }
      case 'out':
      case 'err':
      case 'result':
        if (typeof frame['s'] === 'string') {
          this.append({ kind, text: frame['s'] });
        }
        break;
      case 'done':
        this.continuation = frame['more'] === true;
        this.setState('idle');
        break;
      case 'vars':
      case 'children':
      case 'complete': {
        const id = typeof frame['id'] === 'number' ? frame['id'] : 0;
        const request = this.pending.get(id);
        if (request !== undefined) {
          this.pending.delete(id);
          request.resolve(frame);
        }
        break;
      }
    }
  }

  /** Send one line of source. Echoed into the transcript with its prompt. */
  execute(code: string): void {
    this.append({ kind: 'input', text: `${this.continuation ? '... ' : '>>> '}${code}\n` });
    if (!this.send({ id: this.nextRequestId++, op: 'exec', code })) {
      return;
    }
    this.setState('busy');
  }

  async listVariables(): Promise<readonly KernelVariable[]> {
    const data = await this.requestData('vars', {});
    const variables: KernelVariable[] = [];
    for (const item of data) {
      const variable = toKernelVariable(item);
      if (variable !== undefined) {
        variables.push(variable);
      }
    }
    return variables;
  }

  async listChildren(expression: string): Promise<readonly ChildVariable[] | undefined> {
    if (this.currentState === 'exited') {
      return undefined;
    }
    const data = await this.requestData('children', { expression });
    const children: ChildVariable[] = [];
    for (const item of data) {
      const child = toChildVariable(item);
      if (child !== undefined) {
        children.push(child);
      }
    }
    return children;
  }

  /**
   * Completions for a line, computed against the live namespace — which in a
   * REPL beats static analysis, since the interpreter knows what the objects
   * really are.
   */
  async complete(line: string, position: number): Promise<Completions> {
    const empty: Completions = { start: position, items: [] };
    if (this.currentState === 'exited') {
      return empty;
    }
    const frame = await this.request('complete', { line, position });
    const start = frame['start'];
    const items = frame['items'];
    if (typeof start !== 'number' || !Array.isArray(items)) {
      return empty;
    }
    const parsed: CompletionItem[] = [];
    for (const item of items) {
      const completion = toCompletionItem(item);
      if (completion !== undefined) {
        parsed.push(completion);
      }
    }
    return { start, items: parsed };
  }

  private async requestData(
    op: string,
    extra: Record<string, unknown>,
  ): Promise<readonly unknown[]> {
    const frame = await this.request(op, extra);
    return Array.isArray(frame['data']) ? frame['data'] : [];
  }

  private request(
    op: string,
    extra: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const id = this.nextRequestId++;
    return new Promise<Record<string, unknown>>((resolve) => {
      if (!this.send({ id, op, ...extra })) {
        resolve({});
        return;
      }
      this.pending.set(id, { resolve });
    });
  }

  private send(request: Record<string, unknown>): boolean {
    const child = this.child;
    if (child === undefined || child.stdin.destroyed) {
      return false;
    }
    try {
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return true;
    } catch {
      return false;
    }
  }

  /** Ctrl+C: SIGINT raises KeyboardInterrupt inside the running statement. */
  interrupt(): void {
    this.child?.kill('SIGINT');
  }

  clear(): void {
    this.entries = [];
    this.emitChange();
  }

  /** Drop every user variable, keeping the process and the transcript. */
  resetNamespace(): void {
    this.append({ kind: 'notice', text: 'Variables cleared.\n' });
    if (this.send({ id: this.nextRequestId++, op: 'reset' })) {
      this.setState('busy');
    }
  }

  /** Fresh process, empty namespace; the transcript is kept with a marker. */
  restart(): void {
    this.stop();
    this.append({ kind: 'notice', text: '\nRestarting session…\n' });
    this.continuation = false;
    this.start();
  }

  private stop(): void {
    const child = this.child;
    this.child = undefined;
    this.failPending();
    if (child !== undefined) {
      child.removeAllListeners('exit');
      child.kill();
    }
  }

  private failPending(): void {
    for (const [, request] of this.pending) {
      request.resolve({});
    }
    this.pending.clear();
  }

  private append(entry: TranscriptEntry): void {
    this.entries.push(entry);
    if (this.entries.length > SCROLLBACK_LIMIT) {
      this.entries = this.entries.slice(-SCROLLBACK_LIMIT);
      this.emitChange();
      return;
    }
    for (const listener of this.appendListeners) {
      listener(entry);
    }
  }

  private setState(state: SessionState): void {
    if (this.currentState === state) {
      return;
    }
    this.currentState = state;
    this.emitChange();
  }

  private emitChange(): void {
    for (const listener of this.changeListeners) {
      listener();
    }
  }

  dispose(): void {
    this.stop();
    this.currentState = 'exited';
    this.changeListeners.clear();
    this.appendListeners.clear();
  }
}
