/**
 * Tests for mapJwtError (src/middleware/authJwt.js).
 *
 * mapJwtError translates a jose jwtVerify rejection into a specific 401 body
 * message via the error's `.code`, so callers (authJwt/authAdmin/authCli) can
 * return a distinct reason ("Token expired" vs "Invalid token signature" …)
 * instead of a single generic string. See issue #2.
 *
 * Two layers of coverage:
 *  1. REAL jose errors — real RSA keypair, real signed tokens, real jwtVerify
 *     rejections — asserting both the actual `err.code` and the mapped message.
 *     This proves the switch keys match the codes jose 5 really throws.
 *  2. Direct branch coverage — mapJwtError called with synthetic error objects,
 *     covering every case including the fallback and null/undefined input.
 *
 * MONGODB_URI is set before importing, because src/config.js (transitively
 * imported by authJwt.js) reads it at module-load time.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT, CompactSign, jwtVerify } from 'jose';

let mapJwtError;
let privateKey, publicKey, otherPrivateKey;

const now = () => Math.floor(Date.now() / 1000);

// Verify a token and return the rejection, or throw if it unexpectedly succeeds.
async function verifyError(token, key = publicKey, opts = { algorithms: ['RS256'] }) {
  try {
    await jwtVerify(token, key, opts);
  } catch (err) {
    return err;
  }
  throw new Error('jwtVerify unexpectedly succeeded');
}

before(async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unused-placeholder';
  ({ mapJwtError } = await import('../src/middleware/authJwt.js'));
  ({ privateKey, publicKey } = await generateKeyPair('RS256'));
  ({ privateKey: otherPrivateKey } = await generateKeyPair('RS256'));
});

// ---------------------------------------------------------------------------
// Real jose errors
// ---------------------------------------------------------------------------

describe('mapJwtError — real jose rejections', () => {
  it('maps a genuinely expired token to "Token expired"', async () => {
    const token = await new SignJWT({ roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuedAt(now() - 1000)
      .setExpirationTime(now() - 500)
      .sign(privateKey);
    const err = await verifyError(token);
    assert.equal(err.code, 'ERR_JWT_EXPIRED');
    assert.equal(mapJwtError(err), 'Token expired');
  });

  it('maps a token signed by the wrong key to "Invalid token signature"', async () => {
    const token = await new SignJWT({ roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setExpirationTime('1h')
      .sign(otherPrivateKey);
    const err = await verifyError(token);
    assert.equal(err.code, 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED');
    assert.equal(mapJwtError(err), 'Invalid token signature');
  });

  it('maps a valid JWS with a non-object payload to "Malformed token"', async () => {
    // A structurally valid, correctly-signed JWS whose payload is not a
    // top-level JSON object — this is the case jose reports as ERR_JWT_INVALID.
    const token = await new CompactSign(new TextEncoder().encode('"not-an-object"'))
      .setProtectedHeader({ alg: 'RS256' })
      .sign(privateKey);
    const err = await verifyError(token);
    assert.equal(err.code, 'ERR_JWT_INVALID');
    assert.equal(mapJwtError(err), 'Malformed token');
  });

  it('maps a failed claim check (audience mismatch) to "Token validation failed"', async () => {
    const token = await new SignJWT({ roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setExpirationTime('1h')
      .setAudience('expected-aud')
      .sign(privateKey);
    const err = await verifyError(token, publicKey, { algorithms: ['RS256'], audience: 'different-aud' });
    assert.equal(err.code, 'ERR_JWT_CLAIM_VALIDATION_FAILED');
    assert.equal(mapJwtError(err), 'Token validation failed');
  });

  // A typical "garbage" token (wrong number of segments / not base64url) makes
  // jose throw ERR_JWS_INVALID; this shares the "Malformed token" branch with
  // ERR_JWT_INVALID so structurally-broken tokens get a distinct message too.
  it('maps a structurally-broken token (ERR_JWS_INVALID) to "Malformed token"', async () => {
    for (const garbage of ['not-a-jwt', 'aaa.bbb.ccc', '', 'aaa.bbb']) {
      const err = await verifyError(garbage);
      assert.equal(err.code, 'ERR_JWS_INVALID');
      assert.equal(mapJwtError(err), 'Malformed token');
    }
  });

  it('falls back to the generic message when the alg is not allowed', async () => {
    const token = await new SignJWT({ roles: ['ADMIN'] })
      .setProtectedHeader({ alg: 'RS256' })
      .setExpirationTime('1h')
      .sign(privateKey);
    const err = await verifyError(token, publicKey, { algorithms: ['ES256'] });
    assert.equal(err.code, 'ERR_JOSE_ALG_NOT_ALLOWED');
    assert.equal(mapJwtError(err), 'Invalid or expired JWT');
  });
});

// ---------------------------------------------------------------------------
// Direct branch coverage
// ---------------------------------------------------------------------------

describe('mapJwtError — branch coverage', () => {
  const cases = [
    ['ERR_JWT_EXPIRED', 'Token expired'],
    ['ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'Invalid token signature'],
    ['ERR_JWT_INVALID', 'Malformed token'],
    ['ERR_JWS_INVALID', 'Malformed token'],
    ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'Token validation failed'],
  ];

  for (const [code, message] of cases) {
    it(`maps ${code} to "${message}"`, () => {
      assert.equal(mapJwtError({ code }), message);
    });
  }

  it('maps an unknown code to the generic fallback', () => {
    assert.equal(mapJwtError({ code: 'ERR_SOMETHING_ELSE' }), 'Invalid or expired JWT');
  });

  it('maps an error without a code to the generic fallback', () => {
    assert.equal(mapJwtError(new Error('boom')), 'Invalid or expired JWT');
  });

  it('does not throw on null/undefined input (optional chaining)', () => {
    assert.equal(mapJwtError(null), 'Invalid or expired JWT');
    assert.equal(mapJwtError(undefined), 'Invalid or expired JWT');
  });
});

// ---------------------------------------------------------------------------
// Wiring: the three middlewares route their 401 body through mapJwtError
// ---------------------------------------------------------------------------

describe('mapJwtError — wired into all JWT middlewares', () => {
  it('is exported from authJwt.js', () => {
    assert.equal(typeof mapJwtError, 'function');
  });

  for (const file of ['authJwt.js', 'authAdmin.js', 'authCli.js']) {
    it(`${file} uses mapJwtError in its verify .catch`, async () => {
      const { readFile } = await import('node:fs/promises');
      const { fileURLToPath } = await import('node:url');
      const path = fileURLToPath(new URL(`../src/middleware/${file}`, import.meta.url));
      const src = await readFile(path, 'utf8');
      assert.ok(src.includes('mapJwtError(err)'), `${file} must build its 401 body via mapJwtError(err)`);
      assert.ok(
        !/catch\(\(\)\s*=>\s*res\.status\(401\)\.json\(\{\s*error:\s*'Invalid or expired JWT'/.test(src),
        `${file} must not hardcode the old generic 401 string in its catch`,
      );
    });
  }
});
