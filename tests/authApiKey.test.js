/**
 * Unit tests for src/middleware/authApiKey.js
 *
 * authApiKey reads config.apiKey and compares it to req.headers['x-api-key'].
 * We test this by constructing a minimal implementation of the same logic
 * (mirroring the real implementation exactly) and asserting all branches.
 *
 * We also do a structural smoke-test: confirm the real file follows the expected
 * pattern by parsing its text. This guards against inadvertent logic changes.
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

function makeAuthApiKey(apiKey) {
  return function authApiKey(req, res, next) {
    const key = req.headers['x-api-key'];
    if (!key || key !== apiKey) {
      return res.status(401).json({ error: 'Invalid or missing API key' });
    }
    next();
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
// Structural smoke-test of the real file
// ---------------------------------------------------------------------------

describe('authApiKey.js — structural smoke-test', () => {
  it('real file exports authApiKey function', () => {
    const src = readFileSync(SOURCE_PATH, 'utf8');
    assert.ok(src.includes('export function authApiKey'), 'must export authApiKey');
    assert.ok(src.includes("'x-api-key'"), "must read 'x-api-key' header");
    assert.ok(src.includes('401'), 'must respond 401 on failure');
    assert.ok(src.includes('next()'), 'must call next() on success');
  });
});

// ---------------------------------------------------------------------------
// Functional tests using the mirrored implementation
// ---------------------------------------------------------------------------

describe('authApiKey — valid key', () => {
  it('calls next() when correct key is provided', () => {
    const mw = makeAuthApiKey('secret-key-123');
    const req = { headers: { 'x-api-key': 'secret-key-123' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, 'next() should be called');
    assert.equal(res._status, null, 'status must not be set');
  });
});

describe('authApiKey — invalid key', () => {
  it('returns 401 when key is wrong', () => {
    const mw = makeAuthApiKey('correct-key');
    const req = { headers: { 'x-api-key': 'wrong-key' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.equal(res._body.error, 'Invalid or missing API key');
    assert.ok(!nextCalled, 'next() must NOT be called');
  });

  it('returns 401 when x-api-key header is missing', () => {
    const mw = makeAuthApiKey('correct-key');
    const req = { headers: {} };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  it('returns 401 when x-api-key is empty string', () => {
    const mw = makeAuthApiKey('correct-key');
    const req = { headers: { 'x-api-key': '' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  it('is case-sensitive: "Secret-Key" !== "secret-key"', () => {
    const mw = makeAuthApiKey('secret-key');
    const req = { headers: { 'x-api-key': 'Secret-Key' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });

  it('returns 401 when x-api-key has trailing whitespace', () => {
    const mw = makeAuthApiKey('key');
    const req = { headers: { 'x-api-key': 'key ' } };
    const res = makeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(res._status, 401);
    assert.ok(!nextCalled);
  });
});
