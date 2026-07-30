import { execFile } from 'node:child_process';
import * as vscode from 'vscode';

/**
 * Which Python runs the console.
 *
 * Preference order: the interpreter the Python extension has selected for the
 * workspace (so the console matches the environment the user's notebooks use),
 * then `python.defaultInterpreterPath`, then whatever `python3` resolves to on
 * PATH. Nothing here is a dependency: the Python extension's API is reached
 * through a hand-written structural interface and validated at runtime, the
 * same doctrine as the Jupyter adapter.
 */

/** Minimal slice of ms-python.python's exported API that we rely on. */
interface PythonEnvironmentApi {
  readonly environments: {
    getActiveEnvironmentPath(resource?: vscode.Uri): unknown;
    resolveEnvironment(path: unknown): Promise<unknown>;
    readonly known?: readonly unknown[];
  };
}

/** A runtime the console can start. */
export interface Runtime {
  readonly language: 'python' | 'r';
  /** Executable to spawn. */
  readonly command: string;
  readonly label: string;
  readonly detail: string;
}

function hasEnvironmentsApi(value: unknown): value is PythonEnvironmentApi {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const environments = (value as Record<string, unknown>)['environments'];
  if (typeof environments !== 'object' || environments === null) {
    return false;
  }
  const record = environments as Record<string, unknown>;
  return (
    typeof record['getActiveEnvironmentPath'] === 'function' &&
    typeof record['resolveEnvironment'] === 'function'
  );
}

/**
 * Pull the executable out of a ResolvedEnvironment. `executable.uri` is
 * genuinely undefined when the extension could not resolve a global
 * interpreter (it branches on the filename being literally "python"), so the
 * environment's own path is the documented fallback.
 */
function executableOf(resolved: unknown): string | undefined {
  if (typeof resolved !== 'object' || resolved === null) {
    return undefined;
  }
  const record = resolved as Record<string, unknown>;
  const executable = record['executable'];
  if (typeof executable === 'object' && executable !== null) {
    const uri = (executable as Record<string, unknown>)['uri'];
    if (typeof uri === 'object' && uri !== null) {
      const fsPath = (uri as Record<string, unknown>)['fsPath'];
      if (typeof fsPath === 'string' && fsPath.length > 0) {
        return fsPath;
      }
    }
  }
  const path = record['path'];
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

async function fromPythonExtension(resource: vscode.Uri | undefined): Promise<string | undefined> {
  try {
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (extension === undefined) {
      return undefined;
    }
    const api: unknown = extension.isActive ? extension.exports : await extension.activate();
    if (!hasEnvironmentsApi(api)) {
      return undefined;
    }
    const active = api.environments.getActiveEnvironmentPath(resource);
    if (active === undefined) {
      return undefined;
    }
    // Throws outright in an untrusted workspace, hence the surrounding catch.
    return executableOf(await api.environments.resolveEnvironment(active));
  } catch {
    return undefined;
  }
}

function environmentLabel(environment: Record<string, unknown>): {
  label: string;
  detail: string;
} {
  const path = typeof environment['path'] === 'string' ? environment['path'] : '';
  const version = environment['version'];
  let versionText = '';
  if (typeof version === 'object' && version !== null) {
    const record = version as Record<string, unknown>;
    const parts = [record['major'], record['minor'], record['micro']].filter(
      (part): part is number => typeof part === 'number',
    );
    versionText = parts.length > 0 ? parts.join('.') : '';
  }
  const nested = environment['environment'];
  let name = '';
  if (typeof nested === 'object' && nested !== null) {
    const record = nested as Record<string, unknown>;
    name = typeof record['name'] === 'string' ? record['name'] : '';
  }
  const label = `Python ${versionText}${name.length > 0 ? ` (${name})` : ''}`.trim();
  return { label, detail: path };
}

/**
 * Every runtime the console could start: the Python environments the Python
 * extension already knows about, plus R when it is on PATH. Discovery is
 * best-effort — a missing extension or a failed probe just shortens the list.
 */
export async function listRuntimes(): Promise<readonly Runtime[]> {
  const runtimes: Runtime[] = [];
  try {
    const extension = vscode.extensions.getExtension('ms-python.python');
    if (extension !== undefined) {
      const api: unknown = extension.isActive ? extension.exports : await extension.activate();
      if (hasEnvironmentsApi(api)) {
        for (const known of api.environments.known ?? []) {
          if (typeof known !== 'object' || known === null) {
            continue;
          }
          const environment = known as Record<string, unknown>;
          const command = executableOf(environment);
          if (command === undefined) {
            continue;
          }
          const { label, detail } = environmentLabel(environment);
          runtimes.push({ language: 'python', command, label, detail });
        }
      }
    }
  } catch {
    // Discovery is a convenience; the default interpreter still works.
  }
  if (runtimes.length === 0) {
    runtimes.push({
      language: 'python',
      command: await resolveInterpreter(undefined),
      label: 'Python',
      detail: 'default interpreter',
    });
  }
  const r = await findR();
  if (r !== undefined) {
    runtimes.push(r);
  }
  return runtimes;
}

/** R, if an interpreter is reachable. Uses the same probe shape as Python. */
async function findR(): Promise<Runtime | undefined> {
  const configured = vscode.workspace.getConfiguration('r').get<string>('rterm.linux');
  for (const candidate of [configured, 'R'].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )) {
    const version = await probeVersion(candidate, ['--version']);
    if (version !== undefined) {
      return {
        language: 'r',
        command: candidate,
        label: `R ${version}`.trim(),
        detail: candidate,
      };
    }
  }
  return undefined;
}

function probeVersion(command: string, args: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile>;
    try {
      child = execFile(command, [...args], { timeout: 3000 }, (error, stdout, stderr) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const match = /\b(\d+\.\d+\.\d+)\b/.exec(`${stdout}\n${stderr}`);
        resolve(match?.[1]);
      });
    } catch {
      resolve(undefined);
      return;
    }
    child.on('error', () => resolve(undefined));
  });
}

/** Interpreter to spawn for `resource`; never throws. */
export async function resolveInterpreter(
  resource: vscode.Uri | undefined,
): Promise<string> {
  const fromExtension = await fromPythonExtension(resource);
  if (fromExtension !== undefined) {
    return fromExtension;
  }
  const configured = vscode.workspace
    .getConfiguration('python', resource ?? null)
    .get<string>('defaultInterpreterPath');
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return configured.trim();
  }
  return 'python3';
}
