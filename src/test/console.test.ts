import * as assert from 'assert';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { ConsoleSession } from '../console/session';

/**
 * Drives a real interpreter through the shipped driver. Skipped when no
 * python3 is on PATH so the suite stays runnable on a bare machine.
 */

const MEDIA = path.join(__dirname, '..', '..', 'media');
const DRIVER = path.join(MEDIA, 'console_driver.py');
const R_DRIVER = path.join(MEDIA, 'console_driver.R');

function available(command: string): boolean {
  try {
    execFileSync(command, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function pythonAvailable(): boolean {
  return available('python3');
}

function waitFor(session: ConsoleSession, done: () => boolean, timeoutMs = 15000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (done()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for the session'));
    }, timeoutMs);
    const unsubscribe = session.onDidChange(() => {
      if (done()) {
        clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Run one statement and resolve once the driver reports it finished.
 * execute() flips the state to busy synchronously, so waiting for idle
 * afterwards cannot observe the idle state that preceded the call.
 */
async function run(session: ConsoleSession, code: string): Promise<void> {
  session.execute(code);
  await waitFor(session, () => session.state === 'idle');
}

function labels(completions: { items: readonly { label: string }[] }): readonly string[] {
  return completions.items.map((item) => item.label);
}

function transcriptOf(session: ConsoleSession, kind: string): string {
  return session.transcript
    .filter((entry) => entry.kind === kind)
    .map((entry) => entry.text)
    .join('');
}

suite('console session', function () {
  this.timeout(60000);

  let session: ConsoleSession | undefined;

  suiteSetup(function () {
    if (!pythonAvailable()) {
      this.skip();
    }
  });

  setup(async () => {
    session = new ConsoleSession(
      1,
      { language: 'python', command: 'python3', label: 'Python', detail: 'test' },
      DRIVER,
      undefined,
    );
    session.start();
    await waitFor(session, () => session?.state === 'idle');
  });

  teardown(() => {
    session?.dispose();
    session = undefined;
  });

  test('starts, reports its version and runs a statement', async () => {
    assert.ok(session);
    assert.match(session.label, /^Python \d+\.\d+\.\d+$/);
    await run(session, 'x = 41 + 1');
    await run(session, 'x');
    assert.strictEqual(transcriptOf(session, 'result').trim(), '42');
  });

  test('separates printed output from an expression result', async () => {
    assert.ok(session);
    await run(session, 'print("printed")');
    assert.strictEqual(transcriptOf(session, 'out').trim(), 'printed');
    assert.strictEqual(transcriptOf(session, 'result'), '');
  });

  test('reports a traceback without killing the session', async () => {
    assert.ok(session);
    await run(session, '1 / 0');
    assert.match(transcriptOf(session, 'err'), /ZeroDivisionError/);
    await run(session, '"still alive"');
    assert.match(transcriptOf(session, 'result'), /still alive/);
  });

  test('asks for more input until a block is complete', async () => {
    assert.ok(session);
    await run(session, 'def twice(n):');
    assert.strictEqual(session.needsMoreInput, true);
    await run(session, '    return n * 2');
    assert.strictEqual(session.needsMoreInput, true);
    await run(session, '');
    assert.strictEqual(session.needsMoreInput, false);
    await run(session, 'twice(21)');
    assert.match(transcriptOf(session, 'result'), /42/);
  });

  test('a syntax error clears the buffer instead of hanging', async () => {
    assert.ok(session);
    await run(session, 'x ===');
    assert.match(transcriptOf(session, 'err'), /SyntaxError/);
    assert.strictEqual(session.needsMoreInput, false);
  });

  test('lists variables, including functions and classes', async () => {
    assert.ok(session);
    await run(session, 'value = [1, 2, 3]');
    // A compound statement needs its blank line, exactly as in a real REPL.
    await run(session, 'def helper(a, b=2): return a');
    await run(session, '');
    await run(session, 'class Thing: pass');
    await run(session, '');
    const variables = await session.listVariables();
    const byName = new Map(variables.map((variable) => [variable.name, variable]));

    const value = byName.get('value');
    assert.ok(value, 'the list is missing');
    assert.strictEqual(value.type, 'builtins.list');
    assert.strictEqual(value.indexedChildrenCount, 3);

    // The whole point of owning the process: Jupyter filters these out.
    assert.strictEqual(byName.get('helper')?.type, 'builtins.function');
    assert.strictEqual(byName.get('Thing')?.type, 'builtins.type');
    // Imported modules and the REPL's "_" are noise, not variables.
    assert.strictEqual(byName.has('_'), false);
  });

  test('expands children to any depth, with live values', async () => {
    assert.ok(session);
    await run(session, 'nested = [{"inner": [10, 20]}]');
    const top = await session.listChildren('nested');
    assert.strictEqual(top?.length, 1);
    assert.strictEqual(top[0]?.expression, 'nested[0]');
    assert.strictEqual(top[0]?.hasChildren, true);

    const level2 = await session.listChildren('nested[0]');
    assert.strictEqual(level2?.[0]?.name, 'inner');

    const level3 = await session.listChildren(level2?.[0]?.expression ?? '');
    assert.deepStrictEqual(
      level3?.map((child) => child.value),
      ['10', '20'],
    );
  });

  test('restarting empties the namespace', async () => {
    assert.ok(session);
    await run(session, 'gone = 1');
    session.restart();
    await waitFor(session, () => session?.state === 'idle');
    const variables = await session.listVariables();
    assert.strictEqual(
      variables.some((variable) => variable.name === 'gone'),
      false,
    );
  });

  test('completes names and attributes from the live namespace', async () => {
    assert.ok(session);
    await run(session, 'calls_per_day = [1, 2, 3]');

    const names = await session.complete('call', 4);
    assert.strictEqual(names.start, 0);
    assert.ok(labels(names).includes('calls_per_day'), labels(names).join(','));

    // Attribute completion only works because the namespace is live.
    const attributes = await session.complete('calls_per_day.app', 17);
    assert.strictEqual(attributes.start, 0);
    assert.ok(
      labels(attributes).includes('calls_per_day.append'),
      labels(attributes).join(','),
    );
  });

  test('completes mid-line, replacing only the token', async () => {
    assert.ok(session);
    await run(session, 'value = 1');
    const line = 'print(val';
    const completions = await session.complete(line, line.length);
    assert.strictEqual(completions.start, 'print('.length);
    assert.ok(labels(completions).includes('value'), labels(completions).join(','));
  });

  test('clear empties the transcript but keeps the session', async () => {
    assert.ok(session);
    await run(session, 'print("before")');
    session.clear();
    assert.strictEqual(session.transcript.length, 0);
    await run(session, '7 * 6');
    assert.match(transcriptOf(session, 'result'), /42/);
  });
});

/**
 * The R driver is a separate implementation of the same protocol, so the
 * host code must drive it without knowing which language it is talking to.
 */
suite('console session: R', function () {
  this.timeout(60000);

  let session: ConsoleSession | undefined;

  suiteSetup(function () {
    if (!available('Rscript')) {
      this.skip();
    }
  });

  setup(async () => {
    session = new ConsoleSession(
      1,
      { language: 'r', command: 'Rscript', label: 'R', detail: 'test' },
      R_DRIVER,
      undefined,
    );
    session.start();
    await waitFor(session, () => session?.state === 'idle');
  });

  teardown(() => {
    session?.dispose();
    session = undefined;
  });

  test('runs a statement and reports its value', async () => {
    assert.ok(session);
    assert.match(session.label, /^R \d+\.\d+/);
    await run(session, 'x <- 41 + 1');
    await run(session, 'x');
    assert.match(transcriptOf(session, 'result'), /42/);
  });

  test('separates printed output, errors and results', async () => {
    assert.ok(session);
    await run(session, 'cat("printed\\n")');
    assert.match(transcriptOf(session, 'out'), /printed/);
    await run(session, 'stop("boom")');
    assert.match(transcriptOf(session, 'err'), /boom/);
    await run(session, '"alive"');
    assert.match(transcriptOf(session, 'result'), /alive/);
  });

  test('asks for more input until a block closes', async () => {
    assert.ok(session);
    await run(session, 'twice <- function(n) {');
    assert.strictEqual(session.needsMoreInput, true);
    await run(session, '  n * 2');
    assert.strictEqual(session.needsMoreInput, true);
    await run(session, '}');
    assert.strictEqual(session.needsMoreInput, false);
    await run(session, 'twice(21)');
    assert.match(transcriptOf(session, 'result'), /42/);
  });

  test('lists variables and expands a data frame into its columns', async () => {
    assert.ok(session);
    await run(session, 'df <- data.frame(a = 1:3, b = c("p", "q", "r"))');
    const variables = await session.listVariables();
    const frame = variables.find((variable) => variable.name === 'df');
    assert.ok(frame, 'df is missing');
    assert.strictEqual(frame.type, 'data.frame');
    assert.strictEqual(frame.indexedChildrenCount, 6);

    const columns = await session.listChildren('df');
    assert.deepStrictEqual(
      columns?.map((column) => column.name),
      ['a', 'b'],
    );
    const cells = await session.listChildren(columns?.[0]?.expression ?? '');
    assert.deepStrictEqual(
      cells?.map((cell) => cell.value),
      ['[1] 1', '[1] 2', '[1] 3'],
    );
  });

  test('completes names from the live session', async () => {
    assert.ok(session);
    await run(session, 'my_measurements <- 1:3');
    const completions = await session.complete('my_me', 5);
    assert.strictEqual(completions.start, 0);
    assert.ok(
      labels(completions).includes('my_measurements'),
      labels(completions).slice(0, 5).join(','),
    );
  });
});
