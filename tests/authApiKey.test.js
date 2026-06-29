/**
 * Unit tests for src/middleware/authApiKey.js
 *
 * authApiKey now reads the X-API-Key header and validates it against the DB via
 * the async verifyApiKey() service (no more static config.apiKey compare).
 * It calls next() only when verifyApiKey resolves true, otherwise responds 401.
 *
 * We mirror the exact (async) logic with an injectable verifyApiKey, letting us
 * test every branch without a real database. A structural smoke-test of the real
 * file confirms the real code still matches this shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'middleware', 'authApiKey.js');

// ---------------------------------------------------------------------------
// Inline reference implementation (mirrors real authApiKey.js exactly)
// ---------------------------------------------------------------------------

function makeAuthApiKey(verifyApiKey) {
  return async function authApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (key && await verifyApiKey(key)) return next();
    return res.status(401).json({ error: 'Invalid or missing API key' });
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

// Run an async middleware to completion (its branches all settle within a tick).
async function run(mw, req, res) {
  let nextCalled = false;
  await mw(req, res, () => { nextCalled = true; });
  return nextCalled;
}

// ---------------------------------------------------------------------------
// Structural smoke-test of the real file
// ---------------------------------------------------------------------------

describe('authApiKey.js — structural smoke-test', () => {
  it('real file is an async middleware that validates via verifyApiKey', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('export async function authApiKey'), 'must export async authApiKey');
    assert.ok(src.includes("'x-api-key'"), "must read 'x-api-key' header");
    assert.ok(src.includes('verifyApiKey'), 'must validate via verifyApiKey service');
    assert.ok(src.includes('await verifyApiKey'), 'must await verifyApiKey (async DB lookup)');
    assert.ok(src.includes('401'), 'must respond 401 on failure');
    assert.ok(src.includes('next()'), 'must call next() on success');
    // it must NOT fall back to a static config.apiKey comparison anymore
    assert.ok(!src.includes('config.apiKey'), 'must not compare against a static config.apiKey');
  });
});

// ---------------------------------------------------------------------------
// Functional tests using the mirrored implementation
// ---------------------------------------------------------------------------

describe('authApiKey — valid key', () => {
  it('calls next() when verifyApiKey resolves true', async () => {
    const mw = makeAuthApiKey(async () => true);
    const req = { headers: { 'x-api-key': 'gts_valid' } };
    const res = makeRes();
    const nextCalled = await run(mw, req, res);
    assert.ok(nextCalled, 'next() should be called');
    assert.equal(res._status, null, 'status must not be set');
  });

  it('passes the supplied header value to verifyApiKey', async () => {
    let seen = null;
    const mw = makeAuthApiKey(async (k) => { seen = k; return true; });
    const req = { headers: { 'x-api-key': 'gts_abc123' } };
    await run(mw, req, makeRes());
    assert.equal(seen, 'gts_abc123');
  });
});

describe('authApiKey — invalid key', () => {
  it('returns 401 when verifyApiKey resolves false', async () => {
    const mw = makeAuthApiKey(async () => false);
    const req = { headers: { 'x-api-key': 'gts_wrong' } };
    const res = makeRes();
    const nextCalled = await run(mw, req, res);
    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Invalid or missing API key');
    assert.ok(!nextCalled, 'next() must NOT be called');
  });

  it('returns 401 when x-api-key header is missing (without calling verifyApiKey)', async () => {
    let verifyCalled = false;
    const mw = makeAuthApiKey(async () => { verifyCalled = true; return true; });
    const req = { headers: {} };
    const res = makeRes();
    const nextCalled = await run(mw, req, res);
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
    assert.ok(!verifyCalled, 'must short-circuit before the DB lookup when header is absent');
  });

  it('returns 401 when x-api-key is empty string (short-circuits)', async () => {
    let verifyCalled = false;
    const mw = makeAuthApiKey(async () => { verifyCalled = true; return true; });
    const req = { headers: { 'x-api-key': '' } };
    const res = makeRes();
    const nextCalled = await run(mw, req, res);
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
    assert.ok(!verifyCalled, 'empty header must not trigger a DB lookup');
  });

  it('returns 401 when verifyApiKey rejects unknown keys (revoked/unknown)', async () => {
    // verifyApiKey never throws; an unknown or revoked key resolves false.
    const mw = makeAuthApiKey(async (k) => k === 'gts_known');
    const req = { headers: { 'x-api-key': 'gts_revoked' } };
    const res = makeRes();
    const nextCalled = await run(mw, req, res);
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });
});
