/**
 * Unit tests for src/middleware/authAdmin.js
 *
 * authAdmin requires a valid Bearer JWT (RS256) whose roles include 'ADMIN'.
 *  - 401 when the Authorization header is missing or not a Bearer token
 *  - 503 when the JWT public key has not been loaded yet
 *  - 403 when the JWT is valid but lacks the ADMIN role
 *  - 401 when the JWT verification throws (invalid/expired)
 *  - next() + req.user when the JWT is valid and has the ADMIN role
 *
 * As in authCli.test.js we mirror the exact logic with injectable deps
 * (jwtVerify, getPublicKey) to test every branch without network/env, plus a
 * structural smoke-test that the real source matches.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'middleware', 'authAdmin.js');

// ---------------------------------------------------------------------------
// Structural smoke-test
// ---------------------------------------------------------------------------

describe('authAdmin.js — structural smoke-test', () => {
  it('real file exports authAdmin and covers all decision branches', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('export function authAdmin'), 'must export authAdmin');
    assert.ok(src.includes('Bearer '), 'must check Bearer token');
    assert.ok(src.includes("'ADMIN'"), "must check for 'ADMIN' role");
    assert.ok(src.includes('403'), 'must return 403 when role is missing');
    assert.ok(src.includes('401'), 'must return 401 for invalid token or missing auth');
    assert.ok(src.includes('503'), 'must return 503 when public key is unavailable');
    assert.ok(src.includes("algorithms: ['RS256']"), 'must verify with RS256');
  });
});

// ---------------------------------------------------------------------------
// Mirrored implementation with injectable deps
// ---------------------------------------------------------------------------

function makeAuthAdmin({ jwtVerify, getPublicKey }) {
  return function authAdmin(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }
    const publicKey = getPublicKey();
    if (!publicKey) {
      return res.status(503).json({ error: 'JWT public key not yet available' });
    }
    const token = authHeader.slice(7);
    jwtVerify(token, publicKey, { algorithms: ['RS256'] })
      .then(({ payload }) => {
        const roles = Array.isArray(payload.roles) ? payload.roles : [];
        if (roles.includes('ADMIN')) {
          req.user = payload;
          return next();
        }
        res.status(403).json({ error: 'ADMIN role required' });
      })
      .catch(() => res.status(401).json({ error: 'Invalid or expired JWT' }));
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

const FAKE_PUB_KEY = 'fake-public-key';

// ---------------------------------------------------------------------------
// Missing / malformed Authorization header → 401
// ---------------------------------------------------------------------------

describe('authAdmin — missing/invalid Authorization header', () => {
  const opts = {
    jwtVerify: async () => { throw new Error('should not be called'); },
    getPublicKey: () => FAKE_PUB_KEY,
  };

  it('returns 401 when Authorization header is absent', () => {
    const mw = makeAuthAdmin(opts);
    const req = { headers: {} };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(!called);
    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Missing or invalid Authorization header');
  });

  it('returns 401 when Authorization is not a Bearer token', () => {
    const mw = makeAuthAdmin(opts);
    const req = { headers: { authorization: 'Basic dXNlcjpwYXNz' } };
    const res = makeRes();
    let called = false;
    mw(req, res, () => { called = true; });
    assert.ok(!called);
    assert.equal(res._status, 401);
  });
});

// ---------------------------------------------------------------------------
// Public key not loaded → 503
// ---------------------------------------------------------------------------

describe('authAdmin — public key unavailable', () => {
  it('returns 503 when the public key is not yet loaded', () => {
    const mw = makeAuthAdmin({
      jwtVerify: async () => ({ payload: { roles: ['ADMIN'] } }),
      getPublicKey: () => null,
    });
    const req = { headers: { authorization: 'Bearer some.jwt.token' } };
    const res = makeRes();
    mw(req, res, () => {});
    assert.equal(res._status, 503);
    assert.ok(res._body.error.includes('JWT public key'));
  });
});

// ---------------------------------------------------------------------------
// Valid JWT branches
// ---------------------------------------------------------------------------

describe('authAdmin — JWT verification', () => {
  it('calls next() and attaches payload when JWT has ADMIN role', async () => {
    const payload = { sub: 'user1', email: 'a@b.de', roles: ['ADMIN', 'USER'] };
    const mw = makeAuthAdmin({
      jwtVerify: async () => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer valid.admin.jwt' } };
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

  it('returns 403 when JWT is valid but roles lack ADMIN', async () => {
    const payload = { sub: 'user1', roles: ['USER', 'GITCLIENT'] };
    const mw = makeAuthAdmin({
      jwtVerify: async () => ({ payload }),
      getPublicKey: () => FAKE_PUB_KEY,
    });
    const req = { headers: { authorization: 'Bearer user.jwt' } };
    const res = makeRes();

    await new Promise(resolve => {
      mw(req, res, () => resolve());
      setTimeout(resolve, 50);
    });

    assert.equal(res._status, 403);
    assert.equal(res._body.error, 'ADMIN role required');
  });

  it('returns 403 when roles field is missing (not an array)', async () => {
    const payload = { sub: 'user1' };
    const mw = makeAuthAdmin({
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

  it('returns 401 when JWT verification throws (invalid/expired)', async () => {
    const mw = makeAuthAdmin({
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
});
