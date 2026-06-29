#!/usr/bin/env node
import axios from 'axios';
import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { execSync } from 'child_process';

const RC_PATH = join(homedir(), '.gtsrc');
const TOKENS_PATH = join(homedir(), '.gitclient', 'tokens.json');

const DEFAULT_BASE_URL = 'https://git.freischule.info';

// Pure auth resolution — no I/O, fully unit-testable. Given the already-read
// RC object, env, and whether the JWT tokens file exists, decide which auth to
// use. Precedence:
//   1. ~/.gtsrc with baseUrl + apiKey → X-API-Key (explicit standalone config wins)
//   2. env GIT_SERVICE_API_KEY        → X-API-Key (baseUrl from GIT_SERVICE_URL or default)
//   3. GitClient JWT tokens present   → Bearer (resolved by loadConfig via auth.js)
// Returns { baseUrl, headers } for the API-key paths, { baseUrl, useJwt: true }
// for the JWT path, or null when nothing is configured.
export function resolveAuth({ rc, env, tokensExist }) {
  if (rc && rc.baseUrl && rc.apiKey) {
    return { baseUrl: rc.baseUrl, headers: { 'X-API-Key': rc.apiKey } };
  }

  const baseUrl = env.GIT_SERVICE_URL || DEFAULT_BASE_URL;

  if (env.GIT_SERVICE_API_KEY) {
    return { baseUrl, headers: { 'X-API-Key': env.GIT_SERVICE_API_KEY } };
  }

  if (tokensExist && env.GIT_SERVICE_URL) {
    return { baseUrl, useJwt: true };
  }

  return null;
}

export async function loadConfig(deps = {}) {
  const {
    env = process.env,
    fileExists = existsSync,
    readFile = readFileSync,
    loadAccessToken = async () => (await import('./auth.js')).getAccessToken(),
  } = deps;

  const rc = fileExists(RC_PATH) ? JSON.parse(readFile(RC_PATH, 'utf8')) : null;
  const auth = resolveAuth({ rc, env, tokensExist: fileExists(TOKENS_PATH) });

  if (!auth) {
    throw new Error(
      `gts is not configured.\n` +
      `Provide one of:\n` +
      `  - ${RC_PATH} with { "baseUrl": "${DEFAULT_BASE_URL}", "apiKey": "your-api-key" }\n` +
      `  - env var GIT_SERVICE_API_KEY (optionally with GIT_SERVICE_URL)\n` +
      `  - GitClient JWT tokens at ${TOKENS_PATH} (with GIT_SERVICE_URL set)`
    );
  }

  if (auth.useJwt) {
    // Import getAccessToken lazily to avoid loading dotenv/auth deps otherwise.
    const accessToken = await loadAccessToken();
    return { baseUrl: auth.baseUrl, headers: { Authorization: `Bearer ${accessToken}` } };
  }

  return auth;
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

  const { baseUrl, headers } = await loadConfig();
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

// Only run the CLI when executed directly (gts ...), not when imported by tests.
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch(err => {
    const msg = err.response?.data?.error || err.message;
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
