/**
 * Tests for runner.startClaude's contract (git-client/src/runner.js).
 *
 * startClaude(issue) now returns `{ promise, kill }`:
 *  - `promise` ALWAYS resolves (never rejects, or the queue's drain loop would
 *    break) with `{ status, code }` where status is
 *    'success' | 'sessionLimit' | 'error'.
 *  - `kill` force-terminates the launched process tree so the queue can reclaim
 *    an issue whose window never reported back.
 *
 * Two aspects are covered:
 *  - Functional: the "no local path configured" branch returns the resolved
 *    { promise, kill } shape WITHOUT spawning a child (spawn is never reached
 *    because the repo has no cwd), so no child process is created.
 *  - Structural: the spawn branch wraps the child in `new Promise`, resolves on
 *    BOTH the `close` and `error` events, maps the exit code to the right
 *    status, and returns a kill handle. Spawning a real `claude` binary is not
 *    reliable in CI and child_process cannot be mocked on this Node version, so
 *    this contract is asserted against the source (same approach as
 *    pollerAuth.test.js's structural smoke-test).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { startClaude } from '../src/runner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'runner.js');

describe('startClaude — no configured repo path', () => {
  it('returns { promise, kill } — a thenable and a kill function', () => {
    // Ensure the repo has no configured path so the early-return branch runs
    // and no child process is spawned.
    delete config.repoPaths['unknown-repo'];
    const result = startClaude({ repo: 'unknown-repo', number: 1, title: 't', body: 'b', url: 'u' });
    assert.ok(result && typeof result.promise.then === 'function', 'must expose a thenable promise');
    assert.equal(typeof result.kill, 'function', 'must expose a kill function');
  });

  it('resolves (does not reject or hang) so the queue keeps draining', async () => {
    delete config.repoPaths['unknown-repo'];
    const { promise } = startClaude({ repo: 'unknown-repo', number: 2, title: 't', body: 'b', url: 'u' });
    await assert.doesNotReject(promise, 'the no-path branch must resolve so the next issue can start');
  });

  it('resolves to { status: "error", code: null, resetAt: null } and its kill is a no-op', async () => {
    delete config.repoPaths['unknown-repo'];
    const { promise, kill } = startClaude({ repo: 'unknown-repo', number: 3, title: 't', body: 'b', url: 'u' });
    const value = await promise;
    assert.deepEqual(value, { status: 'error', code: null, resetAt: null });
    assert.doesNotThrow(() => kill(), 'no-op kill must be safe to call');
  });
});

describe('launchWindows — window auto-close and progress visibility (structural)', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('launches the batch file via an explicit `cmd.exe /c`, not via start\'s file association', () => {
    // Letting `start` resolve .bat through ShellExecute/ftype is not guaranteed
    // to close the window when the script finishes (machine-dependent config),
    // which stalls `start /WAIT` and therefore the whole issue queue. Routing
    // through an explicit `cmd.exe /c batFile` always terminates on its own.
    assert.ok(
      /\['\/c', 'start', '', '\/MAX', '\/WAIT', 'cmd\.exe', '\/c', batFile\]/.test(src),
      'start must hand the batch file to an explicit cmd.exe /c, not rely on file association',
    );
  });

  it('streams progress via verboseClaudeRunner.js instead of only the final message', () => {
    assert.ok(
      /node "\$\{VERBOSE_RUNNER\}" "\$\{promptFile\}"/.test(src),
      'Windows launcher must run verboseClaudeRunner.js, not claude -p --verbose directly',
    );
    assert.ok(!/claude -p --verbose </.test(src), 'must not fall back to the non-streaming --verbose text mode');
  });

  it('echoes the prompt file via `type`, never interpolating its content into the batch script', () => {
    assert.ok(/type "\$\{promptFile\}"/.test(src), 'prompt must be shown via type (safe file read), not embedded inline');
  });

  it('does NOT pause on the session-limit exit code (window auto-closes for retry)', () => {
    // The session-limit branch must only print an informational line and let the
    // window close, so the queue can retry without a human pressing a key.
    assert.ok(
      /if "%EC%"=="\$\{SESSION_LIMIT_EXIT_CODE\}"/.test(src),
      'must compare the exact session-limit code, not use `if errorlevel` (which matches >= N)',
    );
    const sessionBranch = src.slice(
      src.indexOf('if "%EC%"=="${SESSION_LIMIT_EXIT_CODE}"'),
      src.indexOf(') else if not "%EC%"=="0"'),
    );
    assert.ok(!/pause/.test(sessionBranch), 'the session-limit branch must not pause the window');
  });
});

describe('startClaude — spawn branch contract (structural)', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('wraps the spawned child in a Promise assigned before the return', () => {
    assert.ok(/const promise = new Promise\(/.test(src), 'spawn path must build a promise');
  });

  it('returns { promise, kill } from the spawn branch', () => {
    assert.ok(/return \{ promise, kill:/.test(src), 'spawn path must return the promise plus a kill handle');
  });

  it('resolves the Promise on the child "close" event with a status/code object', () => {
    assert.ok(/child\.on\('close'/.test(src), 'must listen for close');
    const closeBlock = src.slice(src.indexOf("child.on('close'"), src.indexOf("child.on('error'"));
    assert.ok(/resolve\(\{/.test(closeBlock), 'close handler must resolve with an object');
    assert.ok(/status:/.test(closeBlock) && /code,/.test(closeBlock), 'close handler must resolve { status, code }');
  });

  it('maps exit codes to the three statuses (success / sessionLimit / error)', () => {
    const closeBlock = src.slice(src.indexOf("child.on('close'"), src.indexOf("child.on('error'"));
    assert.ok(/code === 0 \? 'success'/.test(closeBlock), 'code 0 → success');
    assert.ok(/SESSION_LIMIT_EXIT_CODE \? 'sessionLimit'/.test(closeBlock), 'session-limit code → sessionLimit');
    assert.ok(/'error'/.test(closeBlock), 'any other code → error');
  });

  it('resolves the Promise on the child "error" event (never rejects)', () => {
    assert.ok(/child\.on\('error'/.test(src), 'must listen for error');
    const errorBlock = src.slice(src.indexOf("child.on('error'"));
    assert.ok(/resolve\(\{ status: 'error'/.test(errorBlock), 'error handler must resolve error status, not reject');
    assert.ok(!/reject\(/.test(src), 'startClaude must never reject — the drain loop depends on it');
  });

  it('exposes a kill that force-kills the process tree', () => {
    assert.ok(/kill: \(\) => killProcessTree\(child\)/.test(src), 'kill must delegate to killProcessTree(child)');
    assert.ok(/taskkill/.test(src), 'win32 tree-kill must use taskkill /T /F');
  });
});
