#!/usr/bin/env node
import 'dotenv/config';
import { config } from './config.js';
import { fetchOpenIssues } from './poller.js';
import { startClaude } from './runner.js';

// Track issues we've already started Claude for (in-memory; resets on restart)
const startedIssues = new Set();

function issueKey(issue) {
  return `${issue.repo}:${issue.number}`;
}

async function poll() {
  try {
    const issues = await fetchOpenIssues();
    for (const issue of issues) {
      const key = issueKey(issue);
      if (!startedIssues.has(key)) {
        startedIssues.add(key);
        startClaude(issue);
      }
    }
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
