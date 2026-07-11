// Drains discovered issues, normally one at a time (serial) so a single Claude
// process runs at once, in order of discovery. Dedupes poll-driven issues by
// repo:number so an issue is never started twice across repeated poll() calls.
//
// Serial draining is escalated when a run gets stuck, so one hung issue can
// never block the whole queue indefinitely:
//   - session limit  → the WHOLE queue is paused (see below), then the issue is
//     re-queued to the front once the cooldown elapses
//   - stuck ≥ escalateAfterMs (2h) → the next issue is started in PARALLEL
//   - stuck ≥ killAfterMs   (24h) → the run is force-killed and re-queued now
//
// Session limits are a GLOBAL cap on the Claude account, not a per-issue one:
// any other issue started during the cooldown would immediately hit the same
// wall. So a session limit gates the entire queue (sessionLimitCooldownUntil)
// rather than just re-queueing the one affected issue. The cooldown length is
// derived from the reset time Claude printed (resetAt + sessionLimitBufferMs)
// when runner.js could parse it; otherwise it falls back to the fixed
// sessionLimitRetryMs delay. This re-evaluates on every session-limit event.
//
// `runIssue` is injected (normally startClaude) and must return
// `{ promise, kill }`: `promise` resolves with `{ status, code, resetAt }` where
// status is 'success' | 'sessionLimit' | 'error' and never rejects, and resetAt
// is a Date (parsed reset time) or null; `kill` force-terminates the launched
// process tree. All timing constants and `now` are injectable so the escalation
// behavior is unit-testable without real timers.

// Pure: how long to keep the queue paused after a session limit. Prefers the
// parsed reset time plus a buffer; clamps to [1min, 6h] so a bad parse (absurd
// date) or a target time that just slipped into the past can't wedge the queue.
export function computeSessionLimitDelay(result, nowMs, { sessionLimitBufferMs, sessionLimitRetryMs }) {
  const resetAt = result?.resetAt;
  if (resetAt instanceof Date && !Number.isNaN(resetAt.getTime())) {
    const delay = resetAt.getTime() + sessionLimitBufferMs - nowMs;
    return Math.min(Math.max(delay, 60 * 1000), 6 * 60 * 60 * 1000);
  }
  return sessionLimitRetryMs;
}

export function createIssueQueue(runIssue, options = {}) {
  const {
    escalateAfterMs = 2 * 60 * 60 * 1000, // 2h: open a parallel window
    killAfterMs = 24 * 60 * 60 * 1000, // 24h: force-kill and requeue
    sessionLimitRetryMs = 30 * 60 * 1000, // 30min: fallback delay when no reset time parsed
    sessionLimitBufferMs = 10 * 60 * 1000, // 10min: buffer added to the parsed reset time
    staleCheckIntervalMs = 60 * 1000, // 60s: how often to check for stuck runs
    now = Date.now,
  } = options;

  const startedIssues = new Set();
  const issueQueue = [];
  // key → { issue, startedAt, kill }
  const active = new Map();
  let staleTicker = null;
  // epoch ms until which NO issue may start (global session-limit cooldown).
  let sessionLimitCooldownUntil = 0;

  const issueKey = (issue) => `${issue.repo}:${issue.number}`;

  // A new run may start when nothing is active, or when every active run has
  // already been stuck for at least escalateAfterMs (parallel escalation).
  function canStart() {
    // Global gate: a session limit pauses starting EVERY issue, not just the
    // one that triggered it — the cap is account-wide.
    if (now() < sessionLimitCooldownUntil) return false;
    if (issueQueue.length === 0) return false;
    if (active.size === 0) return true;
    const t = now();
    for (const entry of active.values()) {
      if (t - entry.startedAt < escalateAfterMs) return false;
    }
    return true;
  }

  function startRun(issue) {
    const key = issueKey(issue);
    const { promise, kill } = runIssue(issue);
    active.set(key, { issue, startedAt: now(), kill });

    promise.then(result => {
      // Only settle if this exact run is still the active one — a stale-kill
      // may already have removed it and started a fresh attempt.
      if (active.get(key)?.kill !== kill) return;
      active.delete(key);

      if (result?.status === 'sessionLimit') {
        // Bypass the startedIssues dedup on purpose: the issue is already
        // marked "seen", but a session limit is temporary and must retry.
        const delay = computeSessionLimitDelay(result, now(), { sessionLimitBufferMs, sessionLimitRetryMs });
        // Pause the whole queue until the cooldown. If several runs are limited
        // at once, the latest reset time wins.
        sessionLimitCooldownUntil = Math.max(sessionLimitCooldownUntil, now() + delay);
        const timer = setTimeout(() => {
          // unshift (not push): retry the limited issue before any issues
          // discovered during the cooldown.
          issueQueue.unshift(issue);
          pump();
        }, delay);
        timer.unref?.();
      }

      pump();
    });
  }

  function pump() {
    while (canStart()) {
      startRun(issueQueue.shift());
    }
  }

  // Kills runs that have exceeded killAfterMs and re-queues them immediately.
  function checkStale() {
    const t = now();
    let killedAny = false;
    for (const [key, entry] of active) {
      if (t - entry.startedAt >= killAfterMs) {
        try {
          entry.kill();
        } catch {
          // best-effort — the process may already be gone
        }
        active.delete(key);
        // Requeue immediately (no delay); dedup bypass is intentional.
        issueQueue.push(entry.issue);
        killedAny = true;
      }
    }
    if (killedAny) pump();
  }

  function ensureTicker() {
    if (staleTicker) return;
    staleTicker = setInterval(checkStale, staleCheckIntervalMs);
    staleTicker.unref?.();
  }

  // Append any not-yet-seen issues and kick off draining. Intentionally does
  // not await anything so a slow issue never blocks the caller (poll()).
  function enqueue(issues) {
    for (const issue of issues) {
      const key = issueKey(issue);
      if (!startedIssues.has(key)) {
        startedIssues.add(key);
        issueQueue.push(issue);
      }
    }
    ensureTicker();
    pump();
  }

  return {
    enqueue,
    get running() { return active.size > 0; },
    get pending() { return issueQueue.length; },
    get activeCount() { return active.size; },
  };
}
