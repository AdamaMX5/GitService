import { MongoClient } from 'mongodb';
import { config } from '../config.js';

// Module-level cache: one MongoClient/Db per process, established on startup.
let client = null;
let db = null;

export async function connectMongo() {
  if (db) return db;
  client = new MongoClient(config.mongo.uri);
  await client.connect();
  db = client.db(config.mongo.dbName);
  console.log(`MongoDB connected (database: ${config.mongo.dbName})`);
  return db;
}

export function getDb() {
  if (!db) throw new Error('MongoDB not connected — call connectMongo() first');
  return db;
}

export function getCollection(name) {
  return getDb().collection(name);
}

export async function closeMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}
