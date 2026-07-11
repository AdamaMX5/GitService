/**
 * Tests for the issue queue (git-client/src/queue.js).
 *
 * Background: the GitClient poller used to spawn one `claude -p` child process
 * per open issue in parallel (fire-and-forget). The user complained that ALL
 * open issues were started at once, with interleaved output and no clear signal
 * of when each finished. The queue now drains issues ONE AT A TIME in the
 * NORMAL case — but a single hung issue may never block the whole queue, so the
 * serial draining is escalated when a run gets stuck:
 *   - session limit             → the WHOLE queue is paused for a cooldown (the
 *                                 cap is account-wide), then the limited issue is
 *                                 re-queued to the FRONT once the cooldown elapses
 *   - stuck ≥ escalateAfterMs    → the NEXT issue is started in PARALLEL
 *   - stuck ≥ killAfterMs        → the run is force-killed and re-queued now
 *
 * createIssueQueue(runIssue, options) takes the runner as an injected
 * dependency. The runner must return `{ promise, kill }` where `promise`
 * resolves with `{ status, code }` (status: 'success' | 'sessionLimit' |
 * 'error') and never rejects. All timing constants and `now` are injectable so
 * the escalation behavior is unit-testable with short/virtual timers — no child
 * processes, no network, no real 2h/24h/30min waits.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIssueQueue, computeSessionLimitDelay } from '../src/queue.js';

const issue = (repo, number) => ({ repo, number, title: `t${number}`, url: `u${number}` });

// Yield to the microtask queue so awaited promise.then continuations run.
const tick = () => new Promise((r) => setImmediate(r));
// Wait real wall-clock ms (used for tests that exercise setTimeout/setInterval).
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// A controllable fake runner. Each invocation records a call whose promise we
// resolve from the test, and whose kill() flips `killed` so we can assert the
// queue force-terminated a stuck run.
function fakeRunner() {
  const calls = [];
  function run(iss) {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    const call = { issue: iss, killed: false };
    call.resolve = (result) => resolve(result);
    call.kill = () => { call.killed = true; };
    calls.push(call);
    return { promise, kill: call.kill };
  }
  return { run, calls };
}

describe('createIssueQueue — normal serial draining', () => {
  it('runs at most one issue at a time under normal (non-stuck) conditions', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();

    assert.equal(q.activeCount, 1, 'exactly one issue running after enqueue');
    assert.equal(r.calls.length, 1, 'second issue must not start before first finishes');
    assert.equal(q.pending, 2);

    r.calls[0].resolve({ status: 'success', code: 0 });
    await tick();
    assert.equal(q.activeCount, 1);
    assert.equal(r.calls.length, 2);

    r.calls[1].resolve({ status: 'success', code: 0 });
    await tick();
    assert.equal(r.calls.length, 3);

    r.calls[2].resolve({ status: 'success', code: 0 });
    await tick();

    assert.equal(q.activeCount, 0);
    assert.equal(q.running, false, 'queue reports not running once drained');
    assert.equal(q.pending, 0);
  });

  it('processes issues in discovery order', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('r', 10), issue('r', 20), issue('r', 30)]);
    for (let i = 0; i < 3; i++) {
      await tick();
      r.calls[i].resolve({ status: 'success', code: 0 });
    }
    await tick();

    assert.deepEqual(r.calls.map((c) => c.issue.number), [10, 20, 30]);
  });

  it('enqueue() returns synchronously without waiting for a slow issue', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(q.running, true, 'queue is actively draining');
    assert.equal(r.calls.length, 1);

    // A subsequent poll can still discover and append more work meanwhile.
    q.enqueue([issue('r', 2)]);
    assert.equal(q.pending, 1, 'new issue queued behind the running one, not started');

    r.calls[0].resolve({ status: 'success', code: 0 });
    await tick();
    r.calls[1].resolve({ status: 'success', code: 0 });
    await tick();
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });

  it('a second enqueue while draining does not start a parallel drain', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(q.activeCount, 1);

    // Re-entrant enqueue while the first is still running (and not yet stuck).
    q.enqueue([issue('r', 2), issue('r', 3)]);
    await tick();
    assert.equal(q.activeCount, 1, 'the fresh run is not stuck, so no parallel start');
    assert.equal(r.calls.length, 1);

    r.calls[0].resolve({ status: 'success', code: 0 });
    await tick();
    r.calls[1].resolve({ status: 'success', code: 0 });
    await tick();
    r.calls[2].resolve({ status: 'success', code: 0 });
    await tick();
    assert.equal(q.activeCount, 0);
  });

  it('never processes the same issue twice, even across poll cycles (dedup by repo:number)', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();
    r.calls[0].resolve({ status: 'success', code: 0 });
    await tick();
    r.calls[1].resolve({ status: 'success', code: 0 });
    await tick();

    // Poll 2 re-reports 1 and 2 (still open) and adds a new issue 3.
    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();

    assert.deepEqual(r.calls.map((c) => c.issue.number), [1, 2, 3]);
  });

  it('dedupes by repo AND number — same number in different repos both run', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);

    q.enqueue([issue('repoA', 1), issue('repoB', 1)]);
    await tick();
    r.calls[0].resolve({ status: 'success', code: 0 });
    await tick();
    r.calls[1].resolve({ status: 'success', code: 0 });
    await tick();
    q.enqueue([issue('repoA', 1)]); // duplicate of repoA#1
    await tick();

    assert.deepEqual(
      r.calls.map((c) => `${c.issue.repo}#${c.issue.number}`),
      ['repoA#1', 'repoB#1'],
    );
  });

  it('an immediately-resolving runIssue (no-repo case) does not stall the queue', async () => {
    // Mirrors runner.startClaude returning { promise: Promise.resolve(...) }
    // when no cwd is configured: the issue is "processed" instantly.
    const seen = [];
    const q = createIssueQueue((iss) => {
      seen.push(iss.number);
      return { promise: Promise.resolve({ status: 'error', code: null }), kill: () => {} };
    });

    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();
    await tick();

    assert.deepEqual(seen, [1, 2, 3], 'all issues drained without stalling');
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });

  it('empty enqueue is a no-op and leaves the queue idle', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run);
    q.enqueue([]);
    await tick();
    assert.equal(r.calls.length, 0);
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });
});

describe('createIssueQueue — stuck-run escalation', () => {
  it('starts the next issue IN PARALLEL once the active run is stuck past escalateAfterMs', async () => {
    let clock = 0;
    const now = () => clock;
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      escalateAfterMs: 1000,
      killAfterMs: 1_000_000, // don't force-kill in this test
      staleCheckIntervalMs: 10_000, // don't let the stale ticker fire in this test
      now,
    });

    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();
    assert.equal(q.activeCount, 1, 'second waits while the first run is still fresh');
    assert.equal(q.pending, 1);

    // Time advances past escalateAfterMs; a later poll (enqueue) re-pumps.
    clock = 1001;
    q.enqueue([]); // a poll that finds no new issues still re-evaluates the queue
    await tick();

    assert.equal(q.activeCount, 2, 'the stuck first run no longer blocks — second starts in parallel');
    assert.equal(q.pending, 0);
    assert.equal(r.calls.length, 2);
  });

  it('does NOT start a parallel run while the active run is still within escalateAfterMs', async () => {
    let clock = 0;
    const now = () => clock;
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      escalateAfterMs: 1000,
      staleCheckIntervalMs: 10_000,
      now,
    });

    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();

    clock = 999; // still just under the escalation threshold
    q.enqueue([]);
    await tick();

    assert.equal(q.activeCount, 1, 'not yet stuck long enough — stays serial');
    assert.equal(q.pending, 1);
  });

  it('force-kills a run stuck past killAfterMs and requeues it immediately (no delay)', async () => {
    let clock = 0;
    const now = () => clock;
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      escalateAfterMs: 1_000_000, // never open a parallel window in this test
      killAfterMs: 1000,
      staleCheckIntervalMs: 5, // real ms — let the stale ticker fire quickly
      now,
    });

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(r.calls.length, 1);
    assert.equal(r.calls[0].killed, false);

    clock = 1001; // now the active run has exceeded killAfterMs
    await wait(30); // let the real stale ticker run checkStale()

    assert.equal(r.calls[0].killed, true, 'the hung run was force-killed');
    assert.equal(r.calls.length, 2, 'the same issue was retried immediately (no delay)');
    assert.equal(r.calls[1].issue.number, 1);
    assert.equal(q.activeCount, 1, 'the retry is active');
    assert.equal(q.pending, 0, 'requeue-then-pump left nothing waiting');
  });

  it('a session-limited run is retried only after sessionLimitRetryMs, not immediately', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      sessionLimitRetryMs: 50, // real ms
      staleCheckIntervalMs: 10_000,
    });

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(r.calls.length, 1);

    r.calls[0].resolve({ status: 'sessionLimit', code: 75 });
    await tick();
    assert.equal(r.calls.length, 1, 'not retried immediately after a session limit');
    assert.equal(q.activeCount, 0, 'the session-limited run is no longer active');

    await wait(90); // exceed sessionLimitRetryMs
    assert.equal(r.calls.length, 2, 'retried after the session-limit delay elapsed');
    assert.equal(r.calls[1].issue.number, 1, 'the same issue is retried');
  });

  it('does NOT retry a run that resolves with a generic error', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      sessionLimitRetryMs: 20,
      staleCheckIntervalMs: 10_000,
    });

    q.enqueue([issue('r', 1)]);
    await tick();
    r.calls[0].resolve({ status: 'error', code: 1 });
    await tick();

    await wait(50); // well past any retry delay
    assert.equal(r.calls.length, 1, 'a generic error is terminal — no automatic retry');
    assert.equal(q.running, false);
  });
});

describe('computeSessionLimitDelay — cooldown length', () => {
  const opts = { sessionLimitBufferMs: 10 * 60 * 1000, sessionLimitRetryMs: 30 * 60 * 1000 };
  const now = 1_000_000_000_000;

  it('uses (resetAt + buffer − now) for a valid future reset time', () => {
    const resetAt = new Date(now + 60 * 60 * 1000); // 1h ahead
    // 1h until reset + 10min buffer = 70min.
    assert.equal(computeSessionLimitDelay({ resetAt }, now, opts), 70 * 60 * 1000);
  });

  it('falls back to sessionLimitRetryMs when resetAt is null / missing / invalid', () => {
    assert.equal(computeSessionLimitDelay({ resetAt: null }, now, opts), opts.sessionLimitRetryMs);
    assert.equal(computeSessionLimitDelay({}, now, opts), opts.sessionLimitRetryMs);
    assert.equal(computeSessionLimitDelay({ resetAt: new Date('nope') }, now, opts), opts.sessionLimitRetryMs);
  });

  it('clamps to a 1min floor when the reset time is (nearly) in the past', () => {
    const resetAt = new Date(now - 20 * 60 * 1000); // 20min ago → resetAt+buffer < now
    assert.equal(computeSessionLimitDelay({ resetAt }, now, opts), 60 * 1000);
  });

  it('clamps to a 6h ceiling for an absurdly distant reset time', () => {
    const resetAt = new Date(now + 100 * 60 * 60 * 1000); // 100h ahead
    assert.equal(computeSessionLimitDelay({ resetAt }, now, opts), 6 * 60 * 60 * 1000);
  });
});

describe('createIssueQueue — global session-limit cooldown gate', () => {
  it('blocks EVERY issue during the cooldown, then retries the limited issue FIRST (unshift)', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run, {
      sessionLimitRetryMs: 80, // real ms — fallback cooldown when no resetAt parsed
      staleCheckIntervalMs: 10_000,
    });

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(r.calls.length, 1);

    // Issue 1 hits the account-wide session limit with no parsed reset time.
    r.calls[0].resolve({ status: 'sessionLimit', resetAt: null });
    await tick();
    assert.equal(q.activeCount, 0, 'the limited run is no longer active');

    // A DIFFERENT issue is discovered while the cooldown is in effect. It must
    // NOT start — the cap is account-wide, so any run would hit the same wall.
    q.enqueue([issue('r', 2)]);
    await tick();
    assert.equal(q.activeCount, 0, 'no issue may start during the global session-limit cooldown');
    assert.equal(r.calls.length, 1, 'the unrelated issue 2 did not start during cooldown');

    // Once the cooldown elapses, the limited issue (unshifted to the front)
    // starts before issue 2, which was enqueued during the cooldown.
    await wait(140);
    assert.equal(r.calls.length, 2, 'draining resumed after the cooldown');
    assert.equal(r.calls[1].issue.number, 1, 'the limited issue is retried FIRST, ahead of issue 2');
    assert.equal(q.pending, 1, 'issue 2 still waits behind the retried issue (serial)');
  });

  it('a generic error does NOT open a cooldown gate (regression)', async () => {
    const r = fakeRunner();
    const q = createIssueQueue(r.run, { staleCheckIntervalMs: 10_000 });

    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();
    assert.equal(r.calls.length, 1);

    r.calls[0].resolve({ status: 'error', code: 1 });
    await tick();

    // No cooldown was armed → the next issue starts immediately.
    assert.equal(r.calls.length, 2, 'a generic error must not gate the queue');
    assert.equal(r.calls[1].issue.number, 2);
  });
});
