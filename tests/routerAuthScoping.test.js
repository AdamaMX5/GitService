/**
 * Integration test for router mounting/auth-scoping in src/index.js.
 *
 * Regression test for a bug where each route file's auth middleware was
 * registered with a path-less `router.use(authX)` at the shared '/' mount
 * point. Because ALL routers are mounted at app.use('/', router), a
 * path-less router.use() runs for EVERY request that falls through into
 * that router — not just its own routes. Concretely: a valid ADMIN-role JWT
 * hitting /admin/api-keys would first pass frontendRouter's authJwt (any
 * valid JWT is fine, no route matches, falls through), then get REJECTED by
 * cliRouter's authCli (403 "GITCLIENT role required") before ever reaching
 * adminRouter's authAdmin check.
 *
 * The fix scopes each router's auth middleware to its own paths:
 *   frontend.js -> router.use(['/repos', '/issue'], authJwt)
 *   cli.js      -> router.use(['/issues', '/cli'], authCli)
 *   webhook.js  -> router.use('/webhook', authApiKey)
 *   admin.js    -> router.use('/admin', authAdmin)
 *
 * Unlike the rest of this suite (which mirrors auth-middleware logic inline
 * to avoid booting the app — see authAdmin.test.js / authCli.test.js), this
 * test builds the REAL Express app: it imports the actual router files from
 * src/routes/*.js and mounts them in the exact order used by src/index.js,
 * so it genuinely exercises router fall-through behaviour end-to-end over
 * real HTTP requests. That mounting/ordering interaction is exactly what
 * the unit tests cannot see, and exactly what caused the bug.
 *
 * To do this without a real MongoDB or a real AuthService:
 *  - MONGODB_URI is set to a harmless placeholder. connectMongo() is never
 *    called, so any route that touches the DB (admin/api-keys) hits the
 *    real getDb() guard ("MongoDB not connected") and the route's own
 *    try/catch turns that into a deterministic 503 — proving the request
 *    reached the real handler (as opposed to being rejected by auth).
 *  - AUTH_SERVICE_URL points at a tiny local HTTP server (spun up in this
 *    file) that serves a real RSA public key over /jwt/public-key. The
 *    real initJwtMiddleware() is called, performing a genuine HTTP round
 *    trip and populating the shared public-key singleton used by
 *    authJwt/authCli/authAdmin. Test JWTs are signed with the matching
 *    private key using `jose`, exactly like a real AuthService token.
 *
 * Env vars are set (and the src modules dynamically imported) BEFORE any
 * static import, because src/config.js reads MONGODB_URI etc. at
 * module-load time and would throw if it were imported first.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';

let appServer;
let baseUrl;
let fakeAuthServer;
let privateKey;

async function signToken(payload) {
  return await new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256' })
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(privateKey);
}

async function request(path, { method = 'GET', token, apiKey, body } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (apiKey) headers['x-api-key'] = apiKey;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${path}`, { method, headers, body: payload });
  let json = null;
  try { json = await res.json(); } catch { /* no/invalid JSON body */ }
  return { status: res.status, body: json };
}

before(async () => {
  // 1. Fake AuthService serving a real RSA public key over HTTP.
  const { publicKey, privateKey: privKey } = await generateKeyPair('RS256');
  privateKey = privKey;
  const publicKeyPem = await exportSPKI(publicKey);

  fakeAuthServer = http.createServer((req, res) => {
    if (req.url === '/jwt/public-key') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', algorithm: 'RS256', public_key: publicKeyPem }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise(resolve => fakeAuthServer.listen(0, '127.0.0.1', resolve));
  const authPort = fakeAuthServer.address().port;

  // 2. Env vars must be set BEFORE any src module is imported, since
  // src/config.js reads them at module-load time (required() throws on
  // missing MONGODB_URI).
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unused-placeholder';
  process.env.AUTH_SERVICE_URL = `http://127.0.0.1:${authPort}`;

  // 3. Dynamically import the REAL app pieces (after env vars are set).
  const { initJwtMiddleware } = await import('../src/middleware/authJwt.js');
  const { default: publicRouter } = await import('../src/routes/public.js');
  const { default: frontendRouter } = await import('../src/routes/frontend.js');
  const { default: cliRouter } = await import('../src/routes/cli.js');
  const { default: webhookRouter } = await import('../src/routes/webhook.js');
  const { default: adminRouter } = await import('../src/routes/admin.js');

  // Real network round-trip to the fake AuthService — populates the actual
  // public-key singleton shared by authJwt/authCli/authAdmin.
  await initJwtMiddleware();

  // 4. Assemble the real app — same middleware/mount order as src/index.js.
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use('/', publicRouter);
  app.use('/', frontendRouter);
  app.use('/', cliRouter);
  app.use('/', webhookRouter);
  app.use('/', adminRouter);

  await new Promise(resolve => {
    appServer = app.listen(0, '127.0.0.1', resolve);
  });
  const port = appServer.address().port;
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  await new Promise(resolve => appServer?.close(resolve));
  await new Promise(resolve => fakeAuthServer?.close(resolve));
});

describe('router auth-scoping regression (bug: path-less router.use() ran for every request)', () => {
  it('ADMIN-role JWT reaches the real /admin/api-keys handler (GET) — not rejected by cliRouter', async () => {
    const token = await signToken({ sub: 'admin1', email: 'admin@flussmark.de', roles: ['USER', 'ADMIN'] });
    const res = await request('/admin/api-keys', { token });
    // Must NOT be cliRouter's GITCLIENT rejection (the bug).
    assert.notEqual(res.status, 403);
    assert.notEqual(res.body?.error, 'GITCLIENT role required');
    // Deterministic: no real Mongo connection => the real handler's own
    // try/catch turns the DB failure into 503. Reaching this proves auth
    // passed (authAdmin accepted the ADMIN role) and the real route
    // handler executed.
    assert.equal(res.status, 503);
    assert.equal(res.body?.error, 'Database unavailable');
  });

  it('ADMIN-role JWT reaches the real /admin/api-keys handler (POST) — not rejected by cliRouter', async () => {
    const token = await signToken({ sub: 'admin1', email: 'admin@flussmark.de', roles: ['USER', 'ADMIN'] });
    const res = await request('/admin/api-keys', { method: 'POST', token, body: { name: 'ci-key' } });
    assert.notEqual(res.status, 403);
    assert.notEqual(res.body?.error, 'GITCLIENT role required');
    assert.equal(res.status, 503);
    assert.equal(res.body?.error, 'Database unavailable');
  });

  it('regression: USER-only JWT (no ADMIN) still gets 403 "ADMIN role required" on GET /admin/api-keys', async () => {
    const token = await signToken({ sub: 'user1', email: 'user@flussmark.de', roles: ['USER'] });
    const res = await request('/admin/api-keys', { token });
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, 'ADMIN role required');
  });

  it('regression: USER-only JWT (no ADMIN) still gets 403 "ADMIN role required" on POST /admin/api-keys', async () => {
    const token = await signToken({ sub: 'user1', email: 'user@flussmark.de', roles: ['USER'] });
    const res = await request('/admin/api-keys', { method: 'POST', token, body: { name: 'x' } });
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, 'ADMIN role required');
  });

  it('regression: USER-only JWT (no GITCLIENT) still gets 403 "GITCLIENT role required" on GET /issues', async () => {
    const token = await signToken({ sub: 'user1', email: 'user@flussmark.de', roles: ['USER'] });
    const res = await request('/issues', { token });
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, 'GITCLIENT role required');
  });

  it('regression: USER-only JWT (no GITCLIENT) still gets 403 "GITCLIENT role required" on GET /cli/issue/:number', async () => {
    const token = await signToken({ sub: 'user1', email: 'user@flussmark.de', roles: ['USER'] });
    const res = await request('/cli/issue/123?repo=some-repo', { token });
    assert.equal(res.status, 403);
    assert.equal(res.body?.error, 'GITCLIENT role required');
  });

  it('regression: GET /repos without an Authorization header still gets 401', async () => {
    const res = await request('/repos');
    assert.equal(res.status, 401);
    assert.equal(res.body?.error, 'Missing or invalid Authorization header');
  });

  it('regression: POST /issue without an Authorization header still gets 401', async () => {
    const res = await request('/issue', { method: 'POST', body: { repo: 'r', title: 't', body: 'b' } });
    assert.equal(res.status, 401);
    assert.equal(res.body?.error, 'Missing or invalid Authorization header');
  });

  it('regression: POST /webhook/email-reply without X-API-Key still gets 401', async () => {
    const res = await request('/webhook/email-reply', {
      method: 'POST',
      body: { from: 'a@b.de', subject: '[GitService #1] hi', body: 'reply body' },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body?.error, 'Invalid or missing API key');
  });
});
