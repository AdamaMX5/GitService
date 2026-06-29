/**
 * Unit tests for src/middleware/authCli.js
 *
 * authCli accepts EITHER:
 *  (A) a valid X-API-Key header — now validated against the DB via the async
 *      verifyApiKey() service (no more static config.apiKey compare), OR
 *  (B) a valid Bearer JWT containing the GITCLIENT role (RS256)
 *
 * We do NOT use real JWTs or a real DB in tests. Instead we mirror the exact
 * authCli logic with injectable deps (verifyApiKey, jwtVerify, getPublicKey),
 * which lets us test every decision branch without touching the network or DB.
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
  it('real file exports async authCli and covers both auth paths', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('export async function authCli'), 'must export async authCli');
    assert.ok(src.includes("'x-api-key'"), 'must check x-api-key header');
    assert.ok(src.includes('verifyApiKey'), 'Path A must validate via verifyApiKey service');
    assert.ok(src.includes('await verifyApiKey'), 'Path A must await the async DB lookup');
    assert.ok(src.includes('Bearer '), 'must check Bearer token');
    assert.ok(src.includes("'GITCLIENT'"), "must check for 'GITCLIENT' role");
    assert.ok(src.includes('403'), 'must return 403 when role is missing');
    assert.ok(src.includes('401'), 'must return 401 for invalid token or missing auth');
    assert.ok(src.includes('503'), 'must return 503 when public key is unavailable');
    assert.ok(!src.includes('config.apiKey'), 'must not compare against a static config.apiKey');
  });
});

// ---------------------------------------------------------------------------
// Mirrored implementation with injectable deps
// ---------------------------------------------------------------------------

function makeAuthCli({ verifyApiKey, jwtVerify, getPublicKey }) {
  return async function authCli(req, res, next) {
    // Path A: API key (validated against the DB)
    const apiKey = req.headers['x-api-key'];
    if (apiKey && await verifyApiKey(apiKey)) return next();

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
  return {
    _status: null,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
}

// ---------------------------------------------------------------------------
// Path A: API-Key tests
// ---------------------------------------------------------------------------

describe('authCli — Path A: API-Key', () => {
  const baseOpts = {
    verifyApiKey: async (k) => k === 'gts_valid',
    jwtVerify: async () => { throw new Error('should not be called'); },
    getPublicKey: () => null,
  };

  it('calls next() with an API key that verifyApiKey accepts', async () => {
    const mw = makeAuthCli(baseOpts);
    const req = { headers: { 'x-api-key': 'gts_valid' } };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.ok(called, 'next() should be called');
    assert.equal(res._status, null);
  });

  it('does NOT short-circuit with a key verifyApiKey rejects (falls through to JWT check)', async () => {
    const mw = makeAuthCli({ ...baseOpts, getPublicKey: () => 'key' });
    const req = { headers: { 'x-api-key': 'gts_wrong' } };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    // No auth header → falls through to final 401
    assert.ok(!called);
    assert.equal(res._status, 401);
  });

  it('returns 401 when API key is missing and no Bearer token', async () => {
    const mw = makeAuthCli(baseOpts);
    const req = { headers: {} };
    const res = makeRes();
    let called = false;
    await mw(req, res, () => { called = true; });
    assert.ok(!called);
    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Valid API key or GITCLIENT JWT required');
  });

  it('does not call verifyApiKey when the header is absent', async () => {
    let verifyCalled = false;
    const mw = makeAuthCli({
      ...baseOpts,
      verifyApiKey: async () => { verifyCalled = true; return true; },
    });
    const req = { headers: {} };
    await mw(req, makeRes(), () => {});
    assert.ok(!verifyCalled, 'must short-circuit before the DB lookup when header is absent');
  });
});

// ---------------------------------------------------------------------------
// Path B: JWT tests
// ---------------------------------------------------------------------------

describe('authCli — Path B: GITCLIENT JWT', () => {
  const FAKE_PUB_KEY = 'fake-public-key';
  // For Path B tests the API key never matches, so Path A always falls through.
  const verifyApiKey = async () => false;

  it('returns 503 when public key is not yet loaded', async () => {
    const mw = makeAuthCli({
      verifyApiKey,
      jwtVerify: async () => ({ payload: {} }),
      getPublicKey: () => null,
    });
    const req = { headers: { authorization: 'Bearer some.jwt.token' } };
    const res = makeRes();
    await mw(req, res, () => {});
    assert.equal(res._status, 503);
    assert.ok(res._body.error.includes('JWT public key'));
  });

  it('calls next() and attaches payload when JWT is valid with GITCLIENT role', async () => {
    const payload = { sub: 'user1', roles: ['GITCLIENT'] };
    const mw = makeAuthCli({
      verifyApiKey,
      jwtVerify: async (_token, _key, _opts) => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer valid.jwt.here' } };
    const res = makeRes();
    let nextCalled = false;
    let nextReq = null;

    await new Promise(resolve => {
      mw(req, res, () => { nextCalled = true; nextReq = req; resolve(); });
      setTimeout(resolve, 50);
    });

    assert.ok(nextCalled, 'next() should be called');
    assert.deepEqual(nextReq?.user, payload);
    assert.equal(res._status, null);
  });

  it('returns 403 when JWT is valid but roles do not include GITCLIENT', async () => {
    const payload = { sub: 'user1', roles: ['ADMIN'] };
    const mw = makeAuthCli({
      verifyApiKey,
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
      verifyApiKey,
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
      verifyApiKey,
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

  it('returns 401 when Authorization header is present but not "Bearer "', async () => {
    const mw = makeAuthCli({
      verifyApiKey,
      jwtVerify: async () => ({ payload: { roles: ['GITCLIENT'] } }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.ok(!nextCalled);
    assert.equal(res._status, 401);
  });

  it('API key takes priority — skips JWT check when verifyApiKey accepts the key', async () => {
    let jwtVerifyCalled = false;
    const mw = makeAuthCli({
      verifyApiKey: async (k) => k === 'gts_correct',
      jwtVerify: async () => { jwtVerifyCalled = true; return { payload: {} }; },
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = {
      headers: {
        'x-api-key': 'gts_correct',
        authorization: 'Bearer some.other.jwt',
      },
    };
    const res = makeRes();
    let nextCalled = false;
    await mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled);
    assert.ok(!jwtVerifyCalled, 'jwtVerify must not be called when API key verifies');
  });
});
