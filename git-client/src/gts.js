#!/usr/bin/env node
import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { execSync } from 'child_process';

const RC_PATH = join(homedir(), '.gtsrc');
const TOKENS_PATH = join(homedir(), '.gitclient', 'tokens.json');

function loadConfig() {
  if (existsSync(RC_PATH)) {
    const rc = JSON.parse(readFileSync(RC_PATH, 'utf8'));
    if (rc.baseUrl && rc.apiKey) {
      return { baseUrl: rc.baseUrl, headers: { 'X-API-Key': rc.apiKey } };
    }
  }
  // Fall back to GitClient JWT tokens
  if (existsSync(TOKENS_PATH)) {
    const tokens = JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
    const envUrl = process.env.GIT_SERVICE_URL;
    if (tokens.access_token && envUrl) {
      return { baseUrl: envUrl, headers: { Authorization: `Bearer ${tokens.access_token}` } };
    }
  }
  throw new Error(
    `gts is not configured.\n` +
    `Create ${RC_PATH} with:\n` +
    `{\n  "baseUrl": "https://git.freischule.info",\n  "apiKey": "your-api-key"\n}`
  );
}

function detectRepo() {
  try {
    const remoteUrl = execSync('git remote get-url origin', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    const match = remoteUrl.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = {};
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        flags[key] = args[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(args[i]);
    }
  }

  return { flags, positional };
}

function printUsage() {
  console.error([
    'Usage:',
    '  gts issue view <number> [--repo <name>]',
    '  gts issue comment <number> --body "..." [--type question] [--repo <name>]',
    '  gts issue close <number> [--repo <name>]',
    '',
    'The --repo flag is auto-detected from the current git remote when omitted.',
  ].join('\n'));
}

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const [command, subcommand, numberStr] = positional;

  if (command !== 'issue' || !subcommand || !numberStr) {
    printUsage();
    process.exit(1);
  }

  const { baseUrl, headers } = loadConfig();
  const number = numberStr;
  const repo = flags.repo || detectRepo();

  if (!repo) {
    console.error('Error: Could not detect repo from git remote. Use --repo <name> to specify it explicitly.');
    process.exit(1);
  }

  const http = axios.create({ baseURL: baseUrl, headers });

  if (subcommand === 'view') {
    const res = await http.get(`/cli/issue/${number}`, { params: { repo } });
    const issue = res.data;
    console.log(`#${issue.number} [${issue.state.toUpperCase()}] ${issue.title}`);
    console.log(`URL:     ${issue.url}`);
    console.log(`Creator: ${issue.creator}`);
    if (issue.body) {
      console.log(`\n${issue.body}`);
    }

  } else if (subcommand === 'comment') {
    if (!flags.body) {
      console.error('Error: --body is required');
      process.exit(1);
    }
    const payload = { repo, body: flags.body };
    if (flags.type) payload.type = flags.type;
    const res = await http.post(`/cli/issue/${number}/comment`, payload);
    const suffix = res.data.emailSent ? ', email sent to issue creator' : '';
    console.log(`Comment posted (id: ${res.data.id}${suffix})`);

  } else if (subcommand === 'close') {
    await http.patch(`/cli/issue/${number}/close`, { repo });
    console.log(`Issue #${number} closed`);

  } else {
    console.error(`Error: Unknown subcommand "${subcommand}"`);
    printUsage();
    process.exit(1);
  }
}

main().catch(err => {
  const msg = err.response?.data?.error || err.message;
  console.error(`Error: ${msg}`);
  process.exit(1);
});
