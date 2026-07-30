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
  };
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
