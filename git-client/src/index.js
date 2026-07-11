#!/usr/bin/env node
import 'dotenv/config';
import { config } from './config.js';
import { fetchOpenIssues } from './poller.js';
import { startClaude } from './runner.js';
import { createIssueQueue } from './queue.js';

// Discovered issues are drained in order of discovery (dedup resets on
// restart). Normally serial — a single Claude process at a time — but the queue
// escalates a stuck run into a parallel start (after 2h) or a force-kill and
// requeue (after 24h) so one hung issue can't block everything. See queue.js.
const queue = createIssueQueue(startClaude);

async function poll() {
  try {
    const issues = await fetchOpenIssues();
    queue.enqueue(issues);
  } catch (err) {
    console.error('[poller] Error fetching issues:', err.message);
  }
}

const intervalMs = config.pollInterval * 1000;
console.log(`GitClient starting — polling ${config.gitServiceUrl} every ${config.pollInterval}s`);

if (Object.keys(config.repoPaths).length === 0) {
  console.warn('Warning: REPO_PATHS is not configured. Claude will not be able to start for any repo.');
}

await poll();
setInterval(poll, intervalMs);
