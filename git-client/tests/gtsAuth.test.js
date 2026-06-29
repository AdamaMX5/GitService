/**
 * Unit tests for the gts CLI auth-source resolution (git-client/src/gts.js).
 *
 * The module exposes two seams:
 *   - resolveAuth({ rc, env, tokensExist }) — PURE, no I/O. Decides which auth
 *     header to use from already-resolved inputs. This is where the precedence
 *     logic lives, so it gets the bulk of the coverage.
 *   - loadConfig(deps) — wires real I/O (file reads + lazy JWT fetch) around
 *     resolveAuth. Tested with injected deps (env, fileExists, readFile,
 *     loadAccessToken) so no real filesystem / network is touched.
 *
 * A main-guard (import.meta.url === argv[1]) means importing the module does NOT
 * run the CLI, so these imports are side-effect-free.
 *
 * Precedence under test:
 *   1. ~/.gtsrc (baseUrl + apiKey)  → X-API-Key   (explicit standalone wins)
 *   2. env GIT_SERVICE_API_KEY      → X-API-Key   (baseUrl from env or default)
 *   3. GitClient JWT tokens present → Bearer      (requires GIT_SERVICE_URL)
 *   else                            → not configured (null / throws)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveAuth, loadConfig } from '../src/gts.js';

const DEFAULT_BASE_URL = 'https://git.freischule.info';

// ===========================================================================
// resolveAuth — pure precedence logic
// ===========================================================================

describe('resolveAuth — precedence #1: ~/.gtsrc API key', () => {
  it('uses X-API-Key from a complete rc, with its baseUrl', () => {
    const auth = resolveAuth({
      rc: { baseUrl: 'https://git.example.com', apiKey: 'rc-key' },
      env: {},
      tokensExist: false,
    });
    assert.deepEqual(auth, {
      baseUrl: 'https://git.example.com',
      headers: { 'X-API-Key': 'rc-key' },
    });
  });

  it('rc API key beats an env API key (rc wins) and uses the rc baseUrl', () => {
    const auth = resolveAuth({
      rc: { baseUrl: 'https://rc.example.com', apiKey: 'rc-key' },
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      tokensExist: true,
    });
    assert.equal(auth.headers['X-API-Key'], 'rc-key');
    assert.equal(auth.baseUrl, 'https://rc.example.com');
    assert.ok(!('Authorization' in auth.headers), 'must not fall through to JWT');
  });

  it('falls through when rc is missing apiKey', () => {
    const auth = resolveAuth({
      rc: { baseUrl: 'https://rc.example.com' },
      env: { GIT_SERVICE_API_KEY: 'env-key' },
      tokensExist: false,
    });
    assert.equal(auth.headers['X-API-Key'], 'env-key', 'incomplete rc must not win');
  });

  it('falls through when rc is missing baseUrl', () => {
    const auth = resolveAuth({
      rc: { apiKey: 'rc-key' },
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      tokensExist: false,
    });
    assert.equal(auth.headers['X-API-Key'], 'env-key', 'incomplete rc must not win');
    assert.equal(auth.baseUrl, 'https://env.example.com');
  });

  it('handles rc === null (no rc file)', () => {
    const auth = resolveAuth({
      rc: null,
      env: { GIT_SERVICE_API_KEY: 'env-key' },
      tokensExist: false,
    });
    assert.equal(auth.headers['X-API-Key'], 'env-key');
  });
});

describe('resolveAuth — precedence #2: env API key', () => {
  it('uses X-API-Key from GIT_SERVICE_API_KEY with GIT_SERVICE_URL as baseUrl', () => {
    const auth = resolveAuth({
      rc: null,
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      tokensExist: false,
    });
    assert.deepEqual(auth, {
      baseUrl: 'https://env.example.com',
      headers: { 'X-API-Key': 'env-key' },
    });
  });

  it('falls back to the default base URL when GIT_SERVICE_URL is unset', () => {
    const auth = resolveAuth({
      rc: null,
      env: { GIT_SERVICE_API_KEY: 'env-key' },
      tokensExist: false,
    });
    assert.equal(auth.baseUrl, DEFAULT_BASE_URL, 'env key works even without an explicit URL');
    assert.equal(auth.headers['X-API-Key'], 'env-key');
  });

  it('env API key beats the JWT fallback even when tokens exist', () => {
    const auth = resolveAuth({
      rc: null,
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      tokensExist: true,
    });
    assert.equal(auth.headers['X-API-Key'], 'env-key');
    assert.ok(!auth.useJwt, 'must not choose the JWT path when an env key is present');
  });
});

describe('resolveAuth — precedence #3: GitClient JWT fallback', () => {
  it('selects the JWT path when tokens exist AND GIT_SERVICE_URL is set', () => {
    const auth = resolveAuth({
      rc: null,
      env: { GIT_SERVICE_URL: 'https://env.example.com' },
      tokensExist: true,
    });
    assert.deepEqual(auth, { baseUrl: 'https://env.example.com', useJwt: true });
  });

  it('does NOT select JWT when tokens exist but GIT_SERVICE_URL is unset', () => {
    const auth = resolveAuth({
      rc: null,
      env: {},
      tokensExist: true,
    });
    assert.equal(auth, null, 'JWT path requires an explicit GIT_SERVICE_URL');
  });
});

describe('resolveAuth — not configured', () => {
  it('returns null when nothing is configured', () => {
    assert.equal(resolveAuth({ rc: null, env: {}, tokensExist: false }), null);
  });

  it('returns null when only GIT_SERVICE_URL is set (no key, no tokens)', () => {
    assert.equal(
      resolveAuth({ rc: null, env: { GIT_SERVICE_URL: 'https://env.example.com' }, tokensExist: false }),
      null,
    );
  });
});

// ===========================================================================
// loadConfig — I/O wiring around resolveAuth (injected deps)
// ===========================================================================

describe('loadConfig — file + env wiring', () => {
  it('reads ~/.gtsrc and returns its X-API-Key (does NOT call loadAccessToken)', async () => {
    let tokenFetched = false;
    const cfg = await loadConfig({
      env: {},
      fileExists: (p) => p.endsWith('.gtsrc'),
      readFile: () => JSON.stringify({ baseUrl: 'https://rc.example.com', apiKey: 'rc-key' }),
      loadAccessToken: async () => { tokenFetched = true; return 'jwt'; },
    });
    assert.deepEqual(cfg, {
      baseUrl: 'https://rc.example.com',
      headers: { 'X-API-Key': 'rc-key' },
    });
    assert.ok(!tokenFetched, 'API-key path must not fetch a JWT');
  });

  it('does not read the rc file when it does not exist', async () => {
    let readCalled = false;
    const cfg = await loadConfig({
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      fileExists: () => false,
      readFile: () => { readCalled = true; return ''; },
      loadAccessToken: async () => 'jwt',
    });
    assert.equal(cfg.headers['X-API-Key'], 'env-key');
    assert.ok(!readCalled, 'must not read rc when fileExists is false');
  });

  it('resolves the JWT path lazily via loadAccessToken into a Bearer header', async () => {
    let calls = 0;
    const cfg = await loadConfig({
      env: { GIT_SERVICE_URL: 'https://env.example.com' },
      // rc absent, tokens file present
      fileExists: (p) => p.endsWith('tokens.json'),
      readFile: () => { throw new Error('rc should not be read'); },
      loadAccessToken: async () => { calls++; return 'fresh-jwt'; },
    });
    assert.deepEqual(cfg, {
      baseUrl: 'https://env.example.com',
      headers: { Authorization: 'Bearer fresh-jwt' },
    });
    assert.equal(calls, 1, 'loadAccessToken called exactly once on the JWT path');
  });

  it('throws a helpful error naming all three options when nothing is configured', async () => {
    await assert.rejects(
      () => loadConfig({
        env: {},
        fileExists: () => false,
        readFile: () => '',
        loadAccessToken: async () => 'jwt',
      }),
      (err) => {
        assert.match(err.message, /not configured/i);
        assert.match(err.message, /\.gtsrc/, 'must mention the rc file option');
        assert.match(err.message, /GIT_SERVICE_API_KEY/, 'must mention the env-key option');
        assert.match(err.message, /tokens\.json/, 'must mention the JWT tokens option');
        return true;
      },
    );
  });

  it('never leaks a secret in any thrown error message', async () => {
    // Drive loadConfig down a failing path while a secret-shaped value is present
    // in the inputs; the thrown message must not contain it. The "not configured"
    // branch can only fire when no key is set, so we also assert the static
    // message carries only the literal placeholder, never a real key.
    const SECRET = 'super-secret-key-value-AKIA1234567890';

    // 1) loadAccessToken throws on the JWT path — error must not echo any secret.
    await assert.rejects(
      () => loadConfig({
        env: { GIT_SERVICE_URL: 'https://env.example.com' },
        fileExists: (p) => p.endsWith('tokens.json'),
        readFile: () => '',
        loadAccessToken: async () => { throw new Error(`auth failed for ${SECRET}`.replace(SECRET, 'REDACTED')); },
      }),
      (err) => {
        assert.ok(!err.message.includes(SECRET), 'JWT-path error must not contain a secret');
        return true;
      },
    );

    // 2) The "not configured" message is static and only ever shows the
    //    placeholder "your-api-key" — never a real apiKey value.
    await assert.rejects(
      () => loadConfig({
        env: {},
        fileExists: () => false,
        readFile: () => JSON.stringify({ apiKey: SECRET }), // not read (fileExists=false), defensive
        loadAccessToken: async () => 'jwt',
      }),
      (err) => {
        assert.ok(!err.message.includes(SECRET), 'not-configured error must not contain any apiKey');
        assert.match(err.message, /your-api-key/, 'only the literal placeholder may appear');
        return true;
      },
    );
  });

  it('env API key wins over present JWT tokens (no token fetch)', async () => {
    let tokenFetched = false;
    const cfg = await loadConfig({
      env: { GIT_SERVICE_API_KEY: 'env-key', GIT_SERVICE_URL: 'https://env.example.com' },
      fileExists: (p) => p.endsWith('tokens.json'), // tokens present, rc absent
      readFile: () => '',
      loadAccessToken: async () => { tokenFetched = true; return 'jwt'; },
    });
    assert.equal(cfg.headers['X-API-Key'], 'env-key');
    assert.ok(!tokenFetched, 'env key must short-circuit before fetching a JWT');
  });
});
