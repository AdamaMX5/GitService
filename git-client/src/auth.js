import axios from 'axios';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import readline from 'readline';
import { config } from './config.js';

const TOKENS_DIR = join(homedir(), '.gitclient');
const TOKENS_PATH = join(TOKENS_DIR, 'tokens.json');

function loadTokens() {
  if (!existsSync(TOKENS_PATH)) return null;
  try {
    return JSON.parse(readFileSync(TOKENS_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  if (!existsSync(TOKENS_DIR)) mkdirSync(TOKENS_DIR, { recursive: true });
  writeFileSync(TOKENS_PATH, JSON.stringify(tokens, null, 2), 'utf8');
}

function isExpired(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return Date.now() >= payload.exp * 1000 - 60_000;
  } catch {
    return true;
  }
}

function extractCookieValue(setCookieHeaders, name) {
  for (const header of setCookieHeaders) {
    const trimmed = header.trim();
    if (trimmed.startsWith(`${name}=`)) {
      return trimmed.split(';')[0].slice(`${name}=`.length);
    }
  }
  return '';
}

async function promptCredentials() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));
  console.log('\nGitClient - Ersteinrichtung');
  const email = await ask('Email (GITCLIENT-Account): ');
  const password = await ask('Passwort: ');
  rl.close();
  return { email, password };
}

async function login(email, password) {
  return axios.post(
    `${config.authServiceUrl}/user/login`,
    {
      email,
      password,
      device_fingerprint: `gitclient-${homedir()}`,
      device_name: 'GitClient',
    },
    { maxRedirects: 0, validateStatus: s => s < 400 }
  );
}

async function refresh(tokens) {
  const cookieHeader = `refresh_token=${tokens.refresh_token}; csrf_token=${tokens.csrf_token}`;
  const res = await axios.post(
    `${config.authServiceUrl}/user/refresh`,
    {},
    {
      headers: {
        Cookie: cookieHeader,
        'X-CSRF-Token': tokens.csrf_token,
      },
    }
  );
  return res.data.access_token;
}

export async function getAccessToken() {
  let tokens = loadTokens();

  if (tokens?.access_token && !isExpired(tokens.access_token)) {
    return tokens.access_token;
  }

  if (tokens?.refresh_token) {
    try {
      const newToken = await refresh(tokens);
      tokens.access_token = newToken;
      saveTokens(tokens);
      return newToken;
    } catch (err) {
      console.warn('Token refresh failed, re-logging in:', err.message);
    }
  }

  const { email, password } = await promptCredentials();
  const res = await login(email, password);
  const setCookies = res.headers['set-cookie'] || [];

  const newTokens = {
    access_token: res.data.access_token,
    refresh_token: extractCookieValue(setCookies, 'refresh_token'),
    csrf_token: extractCookieValue(setCookies, 'csrf_token'),
  };
  saveTokens(newTokens);
  console.log(`\n✅ Login erfolgreich. Tokens gespeichert unter ${TOKENS_PATH}`);
  return newTokens.access_token;
}
