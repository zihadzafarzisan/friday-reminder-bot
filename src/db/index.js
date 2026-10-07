import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { runMigration } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

export const DEFAULT_DB_PATH = path.join(ROOT_DIR, 'data', 'academic.db');
export const TEST_DB_PATH = path.join(ROOT_DIR, 'data', 'test.db');
export const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

let dbInstance = null;

/**
 * Resolves the database file path:
 * 1. Explicitly provided custom path (supports ':memory:')
 * 2. process.env.DB_PATH if defined and non-empty (supports ':memory:')
 * 3. Default local project path (data/academic.db)
 */
export function getDbPath(customPath = null) {
  if (customPath) {
    if (customPath === ':memory:') return ':memory:';
    return path.resolve(customPath);
  }
  if (process.env.DB_PATH && process.env.DB_PATH.trim()) {
    const envPath = process.env.DB_PATH.trim();
    if (envPath === ':memory:') return ':memory:';
    return path.resolve(envPath);
  }
  return DEFAULT_DB_PATH;
}

export function getDb(dbPath = null) {
  if (dbInstance) {
    return dbInstance;
  }

  let resolvedDbPath = getDbPath(dbPath);

  // In test environment, automatically default to TEST_DB_PATH if no specific path was provided
  if (process.env.NODE_ENV === 'test' && !dbPath && !process.env.DB_PATH) {
    resolvedDbPath = TEST_DB_PATH;
  }

  // Safety guard: NEVER open production academic.db during test execution
  if (process.env.NODE_ENV === 'test' && resolvedDbPath === DEFAULT_DB_PATH) {
    throw new Error(`[SAFETY GUARD] Attempted to connect to production database (${DEFAULT_DB_PATH}) while NODE_ENV === 'test'! Test executions must use ':memory:' or 'data/test.db'.`);
  }

  if (resolvedDbPath !== ':memory:') {
    const dbDir = path.dirname(resolvedDbPath);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
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

/**
 * Closes the database and deletes temporary test database files from disk
 */
export function resetTestDb(targetPath = TEST_DB_PATH) {
  closeDb();
  if (targetPath && targetPath !== ':memory:') {
    const resolved = path.resolve(targetPath);
    if (fs.existsSync(resolved)) {
      try { fs.rmSync(resolved, { force: true }); } catch {}
    }
    for (const ext of ['-journal', '-wal', '-shm']) {
      const extra = resolved + ext;
      if (fs.existsSync(extra)) {
        try { fs.rmSync(extra, { force: true }); } catch {}
      }
    }
  }
}
