/**
 * Tests for the unauthenticated public router (src/routes/public.js).
 *
 * `/hello` is a provider-agnostic JSON alias of `/`: some services in the
 * fleet bind `/` to an HTML frontend, so consumers need a stable JSON
 * endpoint. This asserts `/` and `/hello` return the identical body.
 *
 * Env vars are set and the src module dynamically imported BEFORE any src
 * import, because src/config.js reads MONGODB_URI at module-load time.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

let appServer;
let baseUrl;

async function request(path) {
  const res = await fetch(`${baseUrl}${path}`);
  let json = null;
  try { json = await res.json(); } catch { /* no/invalid JSON body */ }
  return { status: res.status, body: json };
}

before(async () => {
  process.env.MONGODB_URI = 'mongodb://127.0.0.1:1/unused-placeholder';

  const { default: publicRouter } = await import('../src/routes/public.js');

  const app = express();
  app.use('/', publicRouter);

  await new Promise(resolve => {
    appServer = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${appServer.address().port}`;
});

after(async () => {
  await new Promise(resolve => appServer?.close(resolve));
});

describe('public router', () => {
  it('GET /hello returns 200 with the GitService message and a version', async () => {
    const res = await request('/hello');
    assert.equal(res.status, 200);
    assert.equal(res.body?.message, "I'm the GitService.");
    assert.equal(typeof res.body?.version, 'string');
  });

  it('GET /hello returns the exact same body as GET /', async () => {
    const root = await request('/');
    const hello = await request('/hello');
    assert.equal(hello.status, 200);
    assert.deepEqual(hello.body, root.body);
  });
});
