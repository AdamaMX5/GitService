// Drains discovered issues one at a time so only a single Claude process runs
// at once, in order of discovery. Dedupes by repo:number so an issue is never
// started twice across repeated poll() calls. `runIssue` is injected (normally
// startClaude) and must return a Promise that resolves when its work is done.
export function createIssueQueue(runIssue) {
  const startedIssues = new Set();
  const issueQueue = [];
  let queueRunning = false;

  const issueKey = (issue) => `${issue.repo}:${issue.number}`;

  async function processQueue() {
    if (queueRunning) return;
    queueRunning = true;
    try {
      while (issueQueue.length > 0) {
        const issue = issueQueue.shift();
        await runIssue(issue);
      }
    } finally {
      queueRunning = false;
    }
  }

  // Append any not-yet-seen issues and kick off draining. Intentionally does
  // not await processQueue() so a slow issue never blocks the caller (poll()).
  function enqueue(issues) {
    for (const issue of issues) {
      const key = issueKey(issue);
      if (!startedIssues.has(key)) {
        startedIssues.add(key);
        issueQueue.push(issue);
      }
    }
    processQueue();
  }

  return {
    enqueue,
    processQueue,
    get running() { return queueRunning; },
    get pending() { return issueQueue.length; },
  };
}
