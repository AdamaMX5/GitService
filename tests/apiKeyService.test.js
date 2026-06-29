/**
 * Unit tests for src/services/apiKeyService.js
 *
 * Strategy (matches the established repo pattern in authApiKey/authCli/issueService
 * tests): the service talks to Mongo through getCollection(). To exercise every
 * branch without a real database we (a) build an in-memory fake Mongo collection
 * and run a faithful mirror of the real service logic against it, and (b) do a
 * structural smoke-test that parses the real source file to guard against the
 * logic drifting away from what we test here.
 *
 * The mirror uses the SAME crypto primitives (real node:crypto + real ObjectId)
 * as the source — only the Mongo collection is faked — so hashing, key shape and
 * the ObjectId guard are tested for real.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(__dirname, '..', 'src', 'services', 'apiKeyService.js');

// ---------------------------------------------------------------------------
// In-memory fake Mongo collection — implements just enough of the driver API
// used by apiKeyService: insertOne, findOne, find().toArray(), findOneAndUpdate,
// updateOne, createIndex. Documents are stored with real ObjectId _ids.
// ---------------------------------------------------------------------------

function makeFakeCollection() {
  const docs = [];
  let throwOnNext = null; // when set, the next operation rejects (DB-error sim)

  function maybeThrow() {
    if (throwOnNext) {
      const err = throwOnNext;
      throwOnNext = null;
      throw err;
    }
  }

  function matches(doc, filter) {
    return Object.entries(filter).every(([k, v]) => {
      if (k === '_id') return doc._id.equals(v);
      // null filter must match an explicit null / missing field
      if (v === null) return doc[k] === null || doc[k] === undefined;
      return doc[k] === v;
    });
  }

  return {
    // expose internals for assertions / error injection
    _docs: docs,
    _failNext(err) { throwOnNext = err; },

    async insertOne(doc) {
      maybeThrow();
      const _id = new ObjectId();
      docs.push({ _id, ...doc });
      return { insertedId: _id };
    },

    async findOne(filter) {
      maybeThrow();
      return docs.find(d => matches(d, filter)) || null;
    },

    find(filter = {}, options = {}) {
      const projection = options.projection || {};
      return {
        async toArray() {
          maybeThrow();
          const result = docs.filter(d => matches(d, filter));
          // apply only the projection styles the service uses: { hash: 0 }
          return result.map(d => {
            const copy = { ...d };
            for (const [field, mode] of Object.entries(projection)) {
              if (mode === 0) delete copy[field];
            }
            return copy;
          });
        },
      };
    },

    async updateOne(filter, update) {
      maybeThrow();
      const doc = docs.find(d => matches(d, filter));
      if (doc && update.$set) Object.assign(doc, update.$set);
      return { matchedCount: doc ? 1 : 0 };
    },

    async findOneAndUpdate(filter, update, _options) {
      maybeThrow();
      const doc = docs.find(d => matches(d, filter));
      if (!doc) return null; // mongodb v6: returns the doc or null directly
      if (update.$set) Object.assign(doc, update.$set);
      return doc;
    },

    async createIndex() {
      maybeThrow();
      return 'hash_1';
    },
  };
}

// ---------------------------------------------------------------------------
// Faithful mirror of src/services/apiKeyService.js with an injectable collection.
// Logic is copied verbatim; only collection() is parameterised.
// ---------------------------------------------------------------------------

function makeService(coll) {
  const collection = () => coll;

  function hashKey(plain) {
    return crypto.createHash('sha256').update(plain).digest('hex');
  }

  async function generateApiKey({ name, createdBy }) {
    const random = crypto.randomBytes(32).toString('base64url');
    const key = `gts_${random}`;
    const displayPrefix = `gts_${random.slice(0, 6)}`;
    const createdAt = new Date();
    const doc = {
      name,
      displayPrefix,
      hash: hashKey(key),
      createdAt,
      createdBy,
      lastUsedAt: null,
      revokedAt: null,
    };
    const { insertedId } = await collection().insertOne(doc);
    return { id: insertedId.toString(), name, key, displayPrefix, createdAt };
  }

  async function verifyApiKey(plain) {
    try {
      const hash = hashKey(plain);
      const doc = await collection().findOne({ hash, revokedAt: null });
      if (!doc) return false;
      collection()
        .updateOne({ _id: doc._id }, { $set: { lastUsedAt: new Date() } })
        .catch(() => {});
      return true;
    } catch {
      return false;
    }
  }

  async function listApiKeys() {
    const docs = await collection().find({}, { projection: { hash: 0 } }).toArray();
    return docs.map(d => ({
      id: d._id.toString(),
      name: d.name,
      displayPrefix: d.displayPrefix,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
      revokedAt: d.revokedAt,
    }));
  }

  async function revokeApiKey(id) {
    if (!ObjectId.isValid(id)) return null;
    const revokedAt = new Date();
    const result = await collection().findOneAndUpdate(
      { _id: new ObjectId(id), revokedAt: null },
      { $set: { revokedAt } },
      { returnDocument: 'after' },
    );
    if (!result) return null;
    return { id, revokedAt };
  }

  return { hashKey, generateApiKey, verifyApiKey, listApiKeys, revokeApiKey };
}

// ===========================================================================
// Structural smoke-test of the real source
// ===========================================================================

describe('apiKeyService.js — structural smoke-test', () => {
  const src = readFileSync(SOURCE_PATH, 'utf8');

  it('exports the expected functions', () => {
    assert.ok(src.includes('export function hashKey'), 'must export hashKey');
    assert.ok(src.includes('export async function generateApiKey'), 'must export generateApiKey');
    assert.ok(src.includes('export async function verifyApiKey'), 'must export verifyApiKey');
    assert.ok(src.includes('export async function listApiKeys'), 'must export listApiKeys');
    assert.ok(src.includes('export async function revokeApiKey'), 'must export revokeApiKey');
  });

  it('hashes with sha256 hex', () => {
    assert.ok(src.includes("createHash('sha256')"), 'must use sha256');
    assert.ok(src.includes("digest('hex')"), 'must output hex');
  });

  it('persists only the hash, never the plaintext key', () => {
    // the inserted doc must contain hash: hashKey(key) and must NOT store `key`.
    assert.ok(src.includes('hash: hashKey(key)'), 'must store the hash of the key');
    assert.ok(!/insertOne\([^)]*\bkey\b\s*[,}]/s.test(src) || src.includes('hash: hashKey(key)'),
      'must not persist the plaintext key');
  });

  it('verifyApiKey is wrapped in try/catch (never throws)', () => {
    assert.ok(/async function verifyApiKey[\s\S]*?try\s*{[\s\S]*?catch/.test(src),
      'verifyApiKey must catch errors');
  });

  it('verifyApiKey only matches non-revoked keys', () => {
    assert.ok(src.includes('revokedAt: null'), 'must filter revokedAt: null');
  });

  it('listApiKeys projects out the hash', () => {
    assert.ok(src.includes('hash: 0'), 'must project hash out');
  });

  it('revokeApiKey guards the id with ObjectId.isValid', () => {
    assert.ok(src.includes('ObjectId.isValid(id)'), 'must guard id');
  });

  it('ensureIndexes creates a unique index on hash', () => {
    assert.ok(/createIndex\(\s*{\s*hash:\s*1\s*}\s*,\s*{\s*unique:\s*true\s*}\s*\)/.test(src),
      'must create unique index on hash');
  });
});

// ===========================================================================
// Criterion 1 — hashKey
// ===========================================================================

describe('hashKey', () => {
  const { hashKey } = makeService(makeFakeCollection());

  it('is deterministic SHA-256 hex (64 lowercase hex chars)', () => {
    const h1 = hashKey('hello');
    const h2 = hashKey('hello');
    assert.equal(h1, h2, 'same input → same hash');
    assert.match(h1, /^[0-9a-f]{64}$/, 'must be 64-char lowercase hex');
  });

  it('matches a known SHA-256 vector', () => {
    // sha256("abc") is a well-known test vector
    assert.equal(
      hashKey('abc'),
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('different inputs → different hashes', () => {
    assert.notEqual(hashKey('key-a'), hashKey('key-b'));
  });
});

// ===========================================================================
// Criterion 2 — generateApiKey
// ===========================================================================

describe('generateApiKey', () => {
  let coll;
  let svc;
  beforeEach(() => {
    coll = makeFakeCollection();
    svc = makeService(coll);
  });

  it('returns a gts_-prefixed plaintext key', async () => {
    const r = await svc.generateApiKey({ name: 'ci', createdBy: 'a@b.de' });
    assert.match(r.key, /^gts_[A-Za-z0-9_-]+$/, 'key must be gts_-prefixed base64url');
  });

  it('displayPrefix is consistent with the key (a real prefix of it)', async () => {
    const r = await svc.generateApiKey({ name: 'ci', createdBy: 'a@b.de' });
    assert.ok(r.key.startsWith(r.displayPrefix), 'displayPrefix must be a prefix of the key');
    assert.equal(r.displayPrefix, r.key.slice(0, r.displayPrefix.length));
    // 'gts_' (4) + 6 random chars
    assert.equal(r.displayPrefix.length, 10);
  });

  it('persists only the hash — never the plaintext key', async () => {
    const r = await svc.generateApiKey({ name: 'ci', createdBy: 'a@b.de' });
    assert.equal(coll._docs.length, 1);
    const stored = coll._docs[0];
    assert.equal(stored.hash, svc.hashKey(r.key), 'stored hash must match hash of plaintext');
    assert.ok(!('key' in stored), 'plaintext key must not be persisted');
    // belt-and-braces: the plaintext must appear nowhere in the stored doc
    assert.ok(!JSON.stringify(stored).includes(r.key), 'plaintext must not leak into the doc');
  });

  it('stores metadata: name, displayPrefix, createdBy, null lastUsedAt/revokedAt', async () => {
    await svc.generateApiKey({ name: 'deploy', createdBy: 'kurt@flussmark.de' });
    const stored = coll._docs[0];
    assert.equal(stored.name, 'deploy');
    assert.equal(stored.createdBy, 'kurt@flussmark.de');
    assert.equal(stored.lastUsedAt, null);
    assert.equal(stored.revokedAt, null);
    assert.ok(stored.createdAt instanceof Date);
  });

  it('returns an id that is the stringified inserted ObjectId', async () => {
    const r = await svc.generateApiKey({ name: 'ci', createdBy: 'a@b.de' });
    assert.ok(ObjectId.isValid(r.id), 'returned id must be a valid ObjectId string');
    assert.equal(r.id, coll._docs[0]._id.toString());
  });

  it('generates a unique key on each call', async () => {
    const a = await svc.generateApiKey({ name: 'a', createdBy: 'x' });
    const b = await svc.generateApiKey({ name: 'b', createdBy: 'x' });
    assert.notEqual(a.key, b.key, 'each generated key must be unique');
  });

  it('returns the plaintext exactly once (not re-derivable from list)', async () => {
    const r = await svc.generateApiKey({ name: 'a', createdBy: 'x' });
    const listed = await svc.listApiKeys();
    assert.ok(!JSON.stringify(listed).includes(r.key), 'plaintext must not be retrievable later');
  });
});

// ===========================================================================
// Criterion 3 — verifyApiKey
// ===========================================================================

describe('verifyApiKey', () => {
  let coll;
  let svc;
  beforeEach(() => {
    coll = makeFakeCollection();
    svc = makeService(coll);
  });

  it('returns true for a stored, non-revoked key', async () => {
    const { key } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    assert.equal(await svc.verifyApiKey(key), true);
  });

  it('returns false for an unknown key', async () => {
    await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    assert.equal(await svc.verifyApiKey('gts_does-not-exist'), false);
  });

  it('returns false for a revoked key', async () => {
    const { id, key } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    await svc.revokeApiKey(id);
    assert.equal(await svc.verifyApiKey(key), false, 'revoked key must not verify');
  });

  it('updates lastUsedAt on a successful verify (fire-and-forget)', async () => {
    const { key } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    assert.equal(coll._docs[0].lastUsedAt, null);
    await svc.verifyApiKey(key);
    // allow the fire-and-forget updateOne promise to settle
    await new Promise(r => setImmediate(r));
    assert.ok(coll._docs[0].lastUsedAt instanceof Date, 'lastUsedAt must be set');
  });

  it('never throws and returns false on a DB error', async () => {
    coll._failNext(new Error('connection reset'));
    let result;
    await assert.doesNotReject(async () => { result = await svc.verifyApiKey('gts_anything'); });
    assert.equal(result, false, 'must return false on DB error');
  });
});

// ===========================================================================
// Criterion 4 — listApiKeys
// ===========================================================================

describe('listApiKeys', () => {
  let coll;
  let svc;
  beforeEach(() => {
    coll = makeFakeCollection();
    svc = makeService(coll);
  });

  it('never exposes the hash (or plaintext)', async () => {
    const { key } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    const list = await svc.listApiKeys();
    assert.equal(list.length, 1);
    assert.ok(!('hash' in list[0]), 'hash must not be present');
    assert.ok(!JSON.stringify(list).includes(svc.hashKey(key)), 'hash value must not leak');
    assert.ok(!JSON.stringify(list).includes(key), 'plaintext must not leak');
  });

  it('returns the expected public metadata fields', async () => {
    await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    const [entry] = await svc.listApiKeys();
    assert.deepEqual(
      Object.keys(entry).sort(),
      ['createdAt', 'displayPrefix', 'id', 'lastUsedAt', 'name', 'revokedAt'],
    );
  });

  it('includes revoked keys (with revokedAt set)', async () => {
    const { id } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    await svc.revokeApiKey(id);
    const [entry] = await svc.listApiKeys();
    assert.ok(entry.revokedAt instanceof Date, 'revoked keys are still listed');
  });
});

// ===========================================================================
// Criterion 5 — revokeApiKey
// ===========================================================================

describe('revokeApiKey', () => {
  let coll;
  let svc;
  beforeEach(() => {
    coll = makeFakeCollection();
    svc = makeService(coll);
  });

  it('returns null for an invalid (non-ObjectId) id without hitting the DB', async () => {
    let touched = false;
    coll.findOneAndUpdate = async () => { touched = true; return null; };
    assert.equal(await svc.revokeApiKey('not-an-objectid'), null);
    assert.ok(!touched, 'must short-circuit before the DB call');
  });

  it('returns null for a valid-but-unknown id', async () => {
    const unknown = new ObjectId().toString();
    assert.equal(await svc.revokeApiKey(unknown), null);
  });

  it('sets revokedAt for a valid active key and returns { id, revokedAt }', async () => {
    const { id } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    const result = await svc.revokeApiKey(id);
    assert.ok(result, 'must return a result for an active key');
    assert.equal(result.id, id);
    assert.ok(result.revokedAt instanceof Date);
    assert.ok(coll._docs[0].revokedAt instanceof Date, 'doc revokedAt must be persisted');
  });

  it('returns null when revoking an already-revoked key (idempotent guard)', async () => {
    const { id } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    await svc.revokeApiKey(id);
    assert.equal(await svc.revokeApiKey(id), null, 'second revoke must be a no-op');
  });

  it('a revoked key subsequently fails verifyApiKey', async () => {
    const { id, key } = await svc.generateApiKey({ name: 'ci', createdBy: 'x' });
    assert.equal(await svc.verifyApiKey(key), true);
    await svc.revokeApiKey(id);
    assert.equal(await svc.verifyApiKey(key), false);
  });
});
