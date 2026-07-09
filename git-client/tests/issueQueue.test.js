/**
 * Tests for the sequential issue queue (git-client/src/queue.js).
 *
 * Background: the GitClient poller used to spawn one `claude -p` child process
 * per open issue in parallel (fire-and-forget). The user complained that ALL
 * open issues were started at once, with interleaved output and no clear signal
 * of when each finished. The queue now drains issues ONE AT A TIME.
 *
 * createIssueQueue(runIssue) takes the runner as an injected dependency, so we
 * drive it with a controllable fake `runIssue` (a manually-resolved Deferred)
 * to assert real ordering / concurrency / dedup behavior against the actual
 * source — no child processes, no network.
 *
 * Acceptance criteria derived from the issue:
 *   1. At most ONE issue is "running" at any instant.
 *   2. Issues are processed in discovery order.
 *   3. A slow first issue does not block enqueue() from returning, nor from
 *      discovering/queuing more issues.
 *   4. The queue continues correctly across multiple enqueue() (poll) calls.
 *   5. An already-seen issue is never processed twice (dedup by repo:number).
 *   6. An issue whose runIssue resolves immediately (e.g. no configured repo
 *      path → Promise.resolve()) does not stall the queue.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createIssueQueue } from '../src/queue.js';

// A promise whose resolution we control from the test.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const issue = (repo, number) => ({ repo, number, title: `t${number}`, url: `u${number}` });

// Yield to the microtask queue so awaited continuations inside processQueue run.
const tick = () => new Promise((r) => setImmediate(r));

describe('createIssueQueue — sequential draining', () => {
  it('runs at most one issue at a time (criterion #1)', async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [];

    const q = createIssueQueue(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const d = deferred();
      gates.push(d);
      await d.promise;
      active--;
    });

    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();

    // Only the first should be running; the rest wait in the queue.
    assert.equal(active, 1, 'exactly one issue running after enqueue');
    assert.equal(maxActive, 1);
    assert.equal(gates.length, 1, 'second issue must not start before first finishes');

    // Finish issue 1 → issue 2 starts, still only one active.
    gates[0].resolve();
    await tick();
    assert.equal(active, 1);
    assert.equal(gates.length, 2);

    gates[1].resolve();
    await tick();
    assert.equal(gates.length, 3);

    gates[2].resolve();
    await tick();

    assert.equal(maxActive, 1, 'concurrency never exceeded 1 across the whole drain');
    assert.equal(active, 0);
    assert.equal(q.running, false, 'queue reports not running once drained');
    assert.equal(q.pending, 0);
  });

  it('processes issues in discovery order (criterion #2)', async () => {
    const order = [];
    const gates = [];
    const q = createIssueQueue(async (iss) => {
      order.push(iss.number);
      const d = deferred();
      gates.push(d);
      await d.promise;
    });

    q.enqueue([issue('r', 10), issue('r', 20), issue('r', 30)]);
    // Drain sequentially, releasing each gate as it appears.
    for (let i = 0; i < 3; i++) {
      await tick();
      gates[i].resolve();
    }
    await tick();

    assert.deepEqual(order, [10, 20, 30], 'issues ran in the order they were discovered');
  });

  it('enqueue() returns synchronously without waiting for a slow issue (criterion #3)', async () => {
    const gate = deferred();
    let finished = false;
    const q = createIssueQueue(async () => { await gate.promise; finished = true; });

    q.enqueue([issue('r', 1)]);
    // Control returned to us even though the first issue is still running.
    await tick();
    assert.equal(finished, false, 'the slow issue is still in-flight');
    assert.equal(q.running, true, 'queue is actively draining');

    // A subsequent poll can still discover and append more work meanwhile.
    q.enqueue([issue('r', 2)]);
    assert.equal(q.pending, 1, 'new issue queued behind the running one, not started');

    gate.resolve();
    await tick();
    await tick();
    assert.equal(finished, true);
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });

  it('a second enqueue while draining does not start a parallel drain (criterion #1 + #4)', async () => {
    let active = 0;
    let maxActive = 0;
    const gates = [];
    const q = createIssueQueue(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      const d = deferred();
      gates.push(d);
      await d.promise;
      active--;
    });

    q.enqueue([issue('r', 1)]);
    await tick();
    assert.equal(active, 1);

    // Re-entrant enqueue while the first is still running.
    q.enqueue([issue('r', 2), issue('r', 3)]);
    await tick();
    assert.equal(active, 1, 'the guard prevents a second concurrent drain');
    assert.equal(gates.length, 1);

    gates[0].resolve();
    await tick();
    gates[1].resolve();
    await tick();
    gates[2].resolve();
    await tick();

    assert.equal(maxActive, 1, 'still strictly one-at-a-time across both enqueue calls');
    assert.equal(active, 0);
  });

  it('continues correctly across multiple separate poll cycles (criterion #4)', async () => {
    const order = [];
    const q = createIssueQueue(async (iss) => { order.push(iss.number); });

    // Each enqueue simulates a poll that finds one new issue. Each runIssue
    // resolves immediately, so the queue fully drains before the next poll.
    q.enqueue([issue('r', 1)]);
    await tick();
    q.enqueue([issue('r', 2)]);
    await tick();
    q.enqueue([issue('r', 3)]);
    await tick();

    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(q.running, false);
  });

  it('never processes the same issue twice, even across poll cycles (criterion #5)', async () => {
    const seen = [];
    const q = createIssueQueue(async (iss) => { seen.push(iss.number); });

    // Poll 1 sees issues 1 and 2.
    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();
    // Poll 2 re-reports 1 and 2 (still open) and adds a new issue 3.
    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();

    assert.deepEqual(seen, [1, 2, 3], 'only the newly-discovered issue is processed on re-poll');
  });

  it('dedupes by repo AND number — same number in different repos both run (criterion #5)', async () => {
    const seen = [];
    const q = createIssueQueue(async (iss) => { seen.push(`${iss.repo}#${iss.number}`); });

    q.enqueue([issue('repoA', 1), issue('repoB', 1)]);
    await tick();
    q.enqueue([issue('repoA', 1)]); // duplicate of repoA#1
    await tick();

    assert.deepEqual(seen, ['repoA#1', 'repoB#1'], 'repo is part of the dedup key; no duplicate');
  });

  it('an immediately-resolving runIssue (no-repo case) does not stall the queue (criterion #6)', async () => {
    const seen = [];
    // Mirrors runner.startClaude returning Promise.resolve() when no cwd is
    // configured: the issue is "processed" instantly and the queue moves on.
    const q = createIssueQueue((iss) => {
      seen.push(iss.number);
      return Promise.resolve();
    });

    q.enqueue([issue('r', 1), issue('r', 2), issue('r', 3)]);
    await tick();

    assert.deepEqual(seen, [1, 2, 3], 'all issues drained without stalling');
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });

  it('empty enqueue is a no-op and leaves the queue idle', async () => {
    let calls = 0;
    const q = createIssueQueue(async () => { calls++; });
    q.enqueue([]);
    await tick();
    assert.equal(calls, 0);
    assert.equal(q.running, false);
    assert.equal(q.pending, 0);
  });

  it('keeps draining even if a runIssue rejects is NOT expected — runner resolves on error', async () => {
    // The real runner resolves (never rejects) on child error, so the queue
    // relies on that contract. We document it: a resolving runner keeps the
    // drain going. (A rejecting runner would break the loop — see runner tests
    // which verify startClaude resolves on both close and error.)
    const seen = [];
    const q = createIssueQueue(async (iss) => { seen.push(iss.number); });
    q.enqueue([issue('r', 1), issue('r', 2)]);
    await tick();
    assert.deepEqual(seen, [1, 2]);
  });
});
