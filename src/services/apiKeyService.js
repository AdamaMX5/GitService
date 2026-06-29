import crypto from 'node:crypto';
import { ObjectId } from 'mongodb';
import { getCollection } from '../db/mongo.js';

const COLLECTION = 'apiKeys';

function collection() {
  return getCollection(COLLECTION);
}

// SHA-256 hex of the plaintext key. High-entropy random keys make SHA-256
// sufficient (no salt/bcrypt needed), mirroring the AuthService refresh-token approach.
export function hashKey(plain) {
  return crypto.createHash('sha256').update(plain).digest('hex');
}

// Create a new API key. The plaintext key is returned exactly once; only its
// hash is persisted (GitHub-PAT style).
export async function generateApiKey({ name, createdBy }) {
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

// Verify a plaintext key against active (non-revoked) keys. Updates lastUsedAt
// fire-and-forget. Never throws — returns false on any DB error.
export async function verifyApiKey(plain) {
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

// List key metadata for admins — never exposes the hash.
export async function listApiKeys() {
  const docs = await collection().find({}, {
    projection: { hash: 0 },
  }).toArray();
  return docs.map(d => ({
    id: d._id.toString(),
    name: d.name,
    displayPrefix: d.displayPrefix,
    createdAt: d.createdAt,
    lastUsedAt: d.lastUsedAt,
    revokedAt: d.revokedAt,
  }));
}

// Soft-revoke a key by id. Returns { id, revokedAt } or null if the id is
// invalid or the key does not exist / is already revoked.
export async function revokeApiKey(id) {
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

// Unique index on hash so identical keys can never coexist and lookups are fast.
export async function ensureIndexes() {
  await collection().createIndex({ hash: 1 }, { unique: true });
}
