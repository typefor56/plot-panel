import * as vscode from 'vscode';
import { type Runtime, resolveInterpreter } from './interpreter';
import { ConsoleSession } from './session';

/**
 * The set of live console sessions and which one is active.
 *
 * A contributed view exists once per window — there is no stable API to spawn
 * a second instance — so several consoles live inside the one view, selected
 * by a tab bar, exactly as Positron does it.
 */
export class ConsoleSessionManager implements vscode.Disposable {
  private readonly sessions: ConsoleSession[] = [];
  private activeId: number | undefined;
  private nextId = 1;
  private readonly listeners = new Set<() => void>();
  private readonly perSession = new Map<number, () => void>();

  constructor(private readonly extensionUri: vscode.Uri) {}

  get all(): readonly ConsoleSession[] {
    return this.sessions;
  }

  get active(): ConsoleSession | undefined {
    return this.sessions.find((session) => session.id === this.activeId);
  }

  onDidChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** The active session, starting a first one if there is none yet. */
  async ensureActive(): Promise<ConsoleSession> {
    const existing = this.active;
    return existing ?? (await this.create());
  }

  /** Start a session on `runtime`, or on the workspace's Python by default. */
  async create(runtime?: Runtime): Promise<ConsoleSession> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    const chosen: Runtime = runtime ?? {
      language: 'python',
      command: await resolveInterpreter(folder?.uri),
      label: 'Python',
      detail: 'workspace interpreter',
    };
    const driverPath = vscode.Uri.joinPath(
      this.extensionUri,
      'media',
      chosen.language === 'r' ? 'console_driver.R' : 'console_driver.py',
    ).fsPath;
    const session = new ConsoleSession(this.nextId++, chosen, driverPath, folder?.uri.fsPath);
    this.sessions.push(session);
    this.perSession.set(
      session.id,
      session.onDidChange(() => this.emit()),
    );
    this.activeId = session.id;
    session.start();
    this.emit();
    return session;
  }

  select(id: number): void {
    if (this.sessions.some((session) => session.id === id)) {
      this.activeId = id;
      this.emit();
    }
  }

  close(id: number): void {
    const index = this.sessions.findIndex((session) => session.id === id);
    if (index === -1) {
      return;
    }
    const [session] = this.sessions.splice(index, 1);
    this.perSession.get(id)?.();
    this.perSession.delete(id);
    session?.dispose();
    if (this.activeId === id) {
      this.activeId = this.sessions[Math.min(index, this.sessions.length - 1)]?.id;
    }
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }

  dispose(): void {
    for (const session of this.sessions) {
      session.dispose();
    }
    this.sessions.length = 0;
    for (const [, unsubscribe] of this.perSession) {
      unsubscribe();
    }
    this.perSession.clear();
    this.listeners.clear();
  }
}
