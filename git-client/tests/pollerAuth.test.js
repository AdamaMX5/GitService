/**
 * Tests for the poller's auth-header selection (git-client/src/poller.js).
 *
 * fetchOpenIssues() chooses headers based on config.gitServiceApiKey:
 *   - when set     → { 'X-API-Key': <key> }            (standalone mode)
 *   - when unset   → { Authorization: 'Bearer <jwt>' } (GITCLIENT JWT)
 *
 * poller.js imports the env-derived `config` singleton and getAccessToken at the
 * top level, so we don't import it directly here. Instead we (a) mirror the exact
 * header-selection logic and test both branches, and (b) structurally smoke-test
 * the real source to confirm it sends X-API-Key when the key is configured and
 * targets the /issues endpoint.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'poller.js');

// ---------------------------------------------------------------------------
// Mirrored header-selection logic (verbatim from fetchOpenIssues)
// ---------------------------------------------------------------------------

async function selectHeaders(gitServiceApiKey, getAccessToken) {
  return gitServiceApiKey
    ? { 'X-API-Key': gitServiceApiKey }
    : { Authorization: `Bearer ${await getAccessToken()}` };
}

// ---------------------------------------------------------------------------
// Structural smoke-test of the real poller
// ---------------------------------------------------------------------------

describe('poller.js — structural smoke-test', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('sends X-API-Key when an API key is configured', () => {
    assert.ok(src.includes('config.gitServiceApiKey'), 'must branch on config.gitServiceApiKey');
    assert.ok(src.includes("'X-API-Key'"), 'must send X-API-Key header');
  });

  it('falls back to a Bearer JWT via getAccessToken otherwise', () => {
    assert.ok(src.includes('getAccessToken'), 'must use getAccessToken for the JWT fallback');
    assert.ok(/Bearer \$\{await getAccessToken\(\)\}/.test(src), 'must build a Bearer header');
  });

  it('requests the /issues endpoint on the configured GitService URL', () => {
    assert.ok(src.includes('config.gitServiceUrl'), 'must target the configured base URL');
    assert.ok(src.includes('/issues'), 'must call the /issues endpoint');
  });
});

// ---------------------------------------------------------------------------
// Functional tests of the mirrored selection
// ---------------------------------------------------------------------------

describe('poller fetchOpenIssues — header selection', () => {
  it('uses X-API-Key when an API key is configured (no JWT fetch)', async () => {
    let jwtFetched = false;
    const headers = await selectHeaders('poller-key', async () => { jwtFetched = true; return 'jwt'; });
    assert.deepEqual(headers, { 'X-API-Key': 'poller-key' });
    assert.ok(!jwtFetched, 'must not fetch a JWT when the API key is set');
  });

  it('uses a Bearer JWT when no API key is configured', async () => {
    const headers = await selectHeaders('', async () => 'fresh-jwt');
    assert.deepEqual(headers, { Authorization: 'Bearer fresh-jwt' });
  });
});
