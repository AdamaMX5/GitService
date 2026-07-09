/**
 * Tests for runner.startClaude's Promise contract (git-client/src/runner.js).
 *
 * The sequential queue awaits startClaude(issue) before moving to the next
 * issue, so startClaude MUST return a Promise that always resolves (never
 * rejects, or the drain loop would break). Two aspects are covered:
 *
 *  - Functional: the "no local path configured" branch returns a resolved
 *    Promise WITHOUT spawning a child. This runs the real code (spawn is never
 *    reached because the repo has no cwd), so no child process is created.
 *  - Structural: the spawn branch wraps the child in `new Promise` and resolves
 *    on BOTH the `close` and `error` events. Spawning a real `claude` binary is
 *    not possible/reliable in CI and child_process cannot be mocked on this
 *    Node version, so this contract is asserted against the source (same
 *    approach as pollerAuth.test.js's structural smoke-test).
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
  it('returns a Promise (thenable), not undefined', () => {
    // Ensure the repo has no configured path so the early-return branch runs
    // and no child process is spawned.
    delete config.repoPaths['unknown-repo'];
    const result = startClaude({ repo: 'unknown-repo', number: 1, title: 't', body: 'b', url: 'u' });
    assert.ok(result && typeof result.then === 'function', 'must return a thenable so the queue can await it');
  });

  it('resolves (does not reject or hang) so the queue keeps draining', async () => {
    delete config.repoPaths['unknown-repo'];
    await assert.doesNotReject(
      startClaude({ repo: 'unknown-repo', number: 2, title: 't', body: 'b', url: 'u' }),
      'the no-path branch must resolve so the next issue can start',
    );
  });

  it('resolves to undefined', async () => {
    delete config.repoPaths['unknown-repo'];
    const value = await startClaude({ repo: 'unknown-repo', number: 3, title: 't', body: 'b', url: 'u' });
    assert.equal(value, undefined);
  });
});

describe('startClaude — spawn branch Promise contract (structural)', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('wraps the spawned child in a returned Promise', () => {
    assert.ok(/return new Promise\(/.test(src), 'spawn path must return a new Promise');
  });

  it('resolves the Promise on the child "close" event', () => {
    assert.ok(/child\.on\('close'/.test(src), 'must listen for close');
    const closeBlock = src.slice(src.indexOf("child.on('close'"), src.indexOf("child.on('error'"));
    assert.ok(/resolve\(\)/.test(closeBlock), 'close handler must resolve the Promise');
  });

  it('resolves the Promise on the child "error" event (never rejects)', () => {
    assert.ok(/child\.on\('error'/.test(src), 'must listen for error');
    const errorBlock = src.slice(src.indexOf("child.on('error'"));
    assert.ok(/resolve\(\)/.test(errorBlock), 'error handler must resolve (not reject) so the queue survives a failed spawn');
    assert.ok(!/reject\(/.test(src), 'startClaude must never reject — the drain loop depends on it');
  });
});
