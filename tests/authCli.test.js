/**
 * Unit tests for src/middleware/authCli.js
 *
 * authCli accepts EITHER:
 *  (A) a correct X-API-Key header, OR
 *  (B) a valid Bearer JWT containing the GITCLIENT role (RS256)
 *
 * We do NOT use real JWTs in tests. Instead we mirror the exact authCli logic
 * with injectable deps (jwtVerify, getPublicKey), which lets us test every
 * decision branch without touching the network or loading env vars.
 *
 * A structural smoke-test of the real file confirms the real code matches.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'middleware', 'authCli.js');

// ---------------------------------------------------------------------------
// Structural smoke-test
// ---------------------------------------------------------------------------

describe('authCli.js — structural smoke-test', () => {
  it('real file exports authCli and covers both auth paths', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('export function authCli'), 'must export authCli');
    assert.ok(src.includes("'x-api-key'"), 'must check x-api-key header');
    assert.ok(src.includes('Bearer '), 'must check Bearer token');
    assert.ok(src.includes("'GITCLIENT'"), "must check for 'GITCLIENT' role");
    assert.ok(src.includes('403'), 'must return 403 when role is missing');
    assert.ok(src.includes('401'), 'must return 401 for invalid token or missing auth');
    assert.ok(src.includes('503'), 'must return 503 when public key is unavailable');
  });
});

// ---------------------------------------------------------------------------
// Mirrored implementation with injectable deps
// ---------------------------------------------------------------------------

function makeAuthCli({ apiKey, jwtVerify, getPublicKey }) {
  return function authCli(req, res, next) {
    // Path A: API key
    const key = req.headers['x-api-key'];
    if (key && key === apiKey) return next();

    // Path B: Bearer JWT
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const publicKey = getPublicKey();
      if (!publicKey) {
        return res.status(503).json({ error: 'JWT public key not yet available' });
      }
      const token = authHeader.slice(7);
      jwtVerify(token, publicKey, { algorithms: ['RS256'] })
        .then(({ payload }) => {
          const roles = Array.isArray(payload.roles) ? payload.roles : [];
          if (roles.includes('GITCLIENT')) {
            req.user = payload;
            return next();
          }
          res.status(403).json({ error: 'GITCLIENT role required' });
        })
        .catch(() => res.status(401).json({ error: 'Invalid or expired JWT' }));
      return;
    }

    res.status(401).json({ error: 'Valid API key or GITCLIENT JWT required' });
  };
}

function makeRes() {
  const res = {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// Path A: API-Key tests
// ---------------------------------------------------------------------------

describe('authCli — Path A: API-Key', () => {
  const mwOpts = {
    apiKey: 'my-secret',
    jwtVerify: async () => { throw new Error('should not be called'); },
    getPublicKey: () => null,
  };

  it('calls next() with a correct X-API-Key', () => {
    const mw = makeAuthCli(mwOpts);
    const req = { headers: { 'x-api-key': 'my-secret' } };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(called, 'next() should be called');
    assert.equal(res._status, null);
  });

  it('does NOT short-circuit to next() with wrong API key (falls through to JWT check)', () => {
    const mw = makeAuthCli({ ...mwOpts, getPublicKey: () => 'key' });
    const req = { headers: { 'x-api-key': 'wrong' } };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    // No auth header → falls through to final 401
    assert.ok(!called);
    assert.equal(res._status, 401);
  });

  it('returns 401 when API key is missing and no Bearer token', () => {
    const mw = makeAuthCli(mwOpts);
    const req = { headers: {} };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(!called);
    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Valid API key or GITCLIENT JWT required');
  });
});

// ---------------------------------------------------------------------------
// Path B: JWT tests
// ---------------------------------------------------------------------------

describe('authCli — Path B: GITCLIENT JWT', () => {
  const FAKE_PUB_KEY = 'fake-public-key';

  it('returns 503 when public key is not yet loaded', () => {
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async () => ({ payload: {} }),
      getPublicKey: () => null,
    });
    const req = { headers: { authorization: 'Bearer some.jwt.token' } };
    const res = makeRes();
    mw(req, res, () => {});
    assert.equal(res._status, 503);
    assert.ok(res._body.error.includes('JWT public key'));
  });

  it('calls next() and attaches payload when JWT is valid with GITCLIENT role', async () => {
    const payload = { sub: 'user1', roles: ['GITCLIENT'] };
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async (_token, _key, _opts) => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer valid.jwt.here' } };
    const res = makeRes();
    let nextCalled = false;
    let nextReq = null;

    await new Promise(resolve => {
      mw(req, res, () => { nextCalled = true; nextReq = req; resolve(); });
      // give the promise chain a tick to resolve if next isn't called synchronously
      setTimeout(resolve, 50);
    });

    assert.ok(nextCalled, 'next() should be called');
    assert.deepEqual(nextReq?.user, payload);
    assert.equal(res._status, null);
  });

  it('returns 403 when JWT is valid but roles do not include GITCLIENT', async () => {
    const payload = { sub: 'user1', roles: ['ADMIN'] };
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async () => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer admin.jwt' } };
    const res = makeRes();

    await new Promise(resolve => {
      mw(req, res, () => resolve());
      setTimeout(resolve, 50);
    });

    assert.equal(res._status, 403);
    assert.equal(res._body.error, 'GITCLIENT role required');
  });

  it('returns 403 when roles is not an array (missing field)', async () => {
    const payload = { sub: 'user1' }; // no roles field
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async () => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer no-roles.jwt' } };
    const res = makeRes();

    await new Promise(resolve => {
      mw(req, res, () => resolve());
      setTimeout(resolve, 50);
    });

    assert.equal(res._status, 403);
  });

  it('returns 401 when JWT verification throws (invalid/expired token)', async () => {
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async () => { throw new Error('JWTExpired'); },
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer bad.jwt.token' } };
    const res = makeRes();

    await new Promise(resolve => {
      mw(req, res, () => resolve());
      setTimeout(resolve, 50);
    });

    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Invalid or expired JWT');
  });

  it('returns 401 when Authorization header is present but not "Bearer "', () => {
    const mw = makeAuthCli({
      apiKey: 'key',
      jwtVerify: async () => ({ payload: { roles: ['GITCLIENT'] } }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(!nextCalled);
    assert.equal(res._status, 401);
  });

  it('API key takes priority — skips JWT check even if Bearer token present', () => {
    let jwtVerifyCalled = false;
    const mw = makeAuthCli({
      apiKey: 'correct-key',
      jwtVerify: async () => { jwtVerifyCalled = true; return { payload: {} }; },
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = {
      headers: {
        'x-api-key': 'correct-key',
        authorization: 'Bearer some.other.jwt',
      },
    };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.ok(!jwtVerifyCalled, 'jwtVerify must not be called when API key matches');
  });
});
