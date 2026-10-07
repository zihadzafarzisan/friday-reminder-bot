import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runMigration } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'academic.db');
export const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let dbInstance = null;

/**
 * Resolves the database file path:
 * 1. Explicitly provided custom path
 * 2. process.env.DB_PATH if defined and non-empty (e.g. /data/academic.db)
 * 3. Default local project path (data/academic.db)
 */
export function getDbPath(customPath = null) {
  if (customPath) {
    return path.resolve(customPath);
  }
  if (process.env.DB_PATH && process.env.DB_PATH.trim()) {
    return path.resolve(process.env.DB_PATH.trim());
  }
  return DEFAULT_DB_PATH;
}

export function getDb(dbPath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  const resolvedDbPath = getDbPath(dbPath);
  const dbDir = path.dirname(resolvedDbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  dbInstance = new DatabaseSync(resolvedDbPath);
  dbInstance.exec('PRAGMA foreign_keys = ON;');

  if (typeof dbInstance.transaction !== 'function') {
    dbInstance.transaction = function (fn) {
      return function (...args) {
        dbInstance.exec('BEGIN TRANSACTION;');
        try {
          const result = fn(...args);
          dbInstance.exec('COMMIT;');
          return result;
        } catch (err) {
          try {
            dbInstance.exec('ROLLBACK;');
          } catch {}
          throw err;
        }
      };
    };
  }

  initSchema(dbInstance);

  return dbInstance;
}

export function initSchema(db) {
  runMigration(db);
  const schemaSql = fs.readFileSync(SCHEMA_PATH, 'utf-8');
  db.exec(schemaSql);
}

export function closeDb() {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
