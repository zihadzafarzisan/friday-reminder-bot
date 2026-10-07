import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb, getDbPath, resetTestDb, initSchema, DEFAULT_DB_PATH, TEST_DB_PATH } from './index.js';
import { runMigration } from './migrate.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..', '..');

/**
 * Removes temporary database file and any SQLite journals/wal files.
 */
export function cleanDatabaseFiles(filePath) {
  if (!filePath || filePath === ':memory:') return;
  const resolved = path.resolve(filePath);
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

/**
 * Seeds a comprehensive test baseline fixture:
 * - User #1 (ID: 1, Discord ID: 1328051283080380559)
 * - 7 Enrolled Courses (CSE330, CSE260, MAT215, CSE220, CSE330L, CSE260L, CSE220L)
 * - 11 Routine Slots across multiple weekdays
 * - 8 Upcoming Concrete Exam Events (Midterms & Finals)
 * - Default Faculty Consultations (MSI, TSM)
 */
export function seedBaselineData(db) {
  // 1. Ensure User #1 exists
  const user1 = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!user1) {
    db.prepare(`
      INSERT INTO users (id, discord_user_id, pairing_code)
      VALUES (1, '1328051283080380559', 'DEFAULT1')
      ON CONFLICT(id) DO UPDATE SET discord_user_id = excluded.discord_user_id;
    `).run();
  }

  // 2. Clear prior User #1 academic entities for idempotent baseline
  db.prepare('DELETE FROM routine_slots WHERE user_id = 1').run();
  db.prepare('DELETE FROM events WHERE user_id = 1').run();
  db.prepare('DELETE FROM courses WHERE user_id = 1').run();

  // 3. Insert baseline courses
  const insertCourse = db.prepare(`
    INSERT INTO courses (id, user_id, code, name, section, faculty, room, credits)
    VALUES (?, 1, ?, ?, ?, ?, ?, 3.0);
  `);

  insertCourse.run(1, 'CSE330', 'Numerical Methods', '11', 'RFTS', '07F-22C');
  insertCourse.run(2, 'CSE260', 'Digital Logic Design', '05', 'PBK', '10B-16C');
  insertCourse.run(3, 'MAT215', 'Complex Variables & Fourier', '13', 'SAN', '12A-11C');
  insertCourse.run(4, 'CSE220', 'Data Structures', '09', 'SWG', '09A-06C');
  insertCourse.run(5, 'CSE330L', 'Numerical Methods Lab', '11', 'TBA', '12F-30L');
  insertCourse.run(6, 'CSE260L', 'Digital Logic Design Lab', '05', 'TBA', 'AS1-12L');
  insertCourse.run(7, 'CSE220L', 'Data Structures Lab', '09', 'TBA', '09B-09L');

  // 4. Insert baseline routine slots
  const insertSlot = db.prepare(`
    INSERT INTO routine_slots (user_id, course_id, day_of_week, start_time, end_time, room)
    VALUES (1, ?, ?, ?, ?, ?);
  `);

  insertSlot.run(1, 'MONDAY', '14:00:00', '15:20:00', '07F-22C');
  insertSlot.run(2, 'MONDAY', '08:00:00', '09:20:00', '10B-16C');
  insertSlot.run(3, 'MONDAY', '09:30:00', '10:50:00', '12A-11C');
  insertSlot.run(7, 'MONDAY', '11:00:00', '13:50:00', '09B-09L');
  insertSlot.run(4, 'SUNDAY', '11:00:00', '12:20:00', '09A-06C');
  insertSlot.run(4, 'TUESDAY', '11:00:00', '12:20:00', '09A-06C');
  insertSlot.run(5, 'TUESDAY', '14:00:00', '16:50:00', '12F-30L');
  insertSlot.run(6, 'TUESDAY', '08:00:00', '10:50:00', 'AS1-12L');
  insertSlot.run(1, 'WEDNESDAY', '14:00:00', '15:20:00', '07F-22C');
  insertSlot.run(2, 'WEDNESDAY', '08:00:00', '09:20:00', '10B-16C');
  insertSlot.run(3, 'WEDNESDAY', '09:30:00', '10:50:00', '12A-11C');

  // 5. Insert baseline exam events (future exams in November 2026 and January 2027)
  const insertEvent = db.prepare(`
    INSERT INTO events (user_id, course_id, type, title, start_time, end_time, room, is_custom)
    VALUES (1, ?, ?, ?, ?, ?, ?, 0);
  `);

  insertEvent.run(2, 'MIDTERM', 'CSE260 Midterm Exam', '2026-11-21T14:00:00+06:00', '2026-11-21T16:00:00+06:00', '10B-16C');
  insertEvent.run(4, 'MIDTERM', 'CSE220 Midterm Exam', '2026-11-22T14:00:00+06:00', '2026-11-22T16:00:00+06:00', '09A-06C');
  insertEvent.run(3, 'MIDTERM', 'MAT215 Midterm Exam', '2026-11-23T08:30:00+06:00', '2026-11-23T10:30:00+06:00', '12A-11C');
  insertEvent.run(1, 'MIDTERM', 'CSE330 Midterm Exam', '2026-11-25T11:00:00+06:00', '2026-11-25T13:00:00+06:00', '07F-22C');
  insertEvent.run(2, 'FINAL', 'CSE260 Final Exam', '2027-01-07T14:00:00+06:00', '2027-01-07T16:00:00+06:00', '10B-16C');
  insertEvent.run(4, 'FINAL', 'CSE220 Final Exam', '2027-01-08T14:00:00+06:00', '2027-01-08T16:00:00+06:00', '09A-06C');
  insertEvent.run(3, 'FINAL', 'MAT215 Final Exam', '2027-01-09T08:30:00+06:00', '2027-01-09T10:30:00+06:00', '12A-11C');
  insertEvent.run(1, 'FINAL', 'CSE330 Final Exam', '2027-01-11T11:00:00+06:00', '2027-01-11T13:00:00+06:00', '07F-22C');

  // 6. Ensure default consultations exist
  const msiCount = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'MSI' COLLATE NOCASE").get().c;
  if (msiCount === 0) {
    db.prepare(`
      INSERT INTO faculty_consultations (faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link)
      VALUES 
        ('MSI', 'Dr. Muhammad Saiful Islam', 'SUNDAY', '10:00', '11:30', 'UB0802', 'saiful.islam@bracu.ac.bd', 'https://meet.google.com/msi-consult'),
        ('MSI', 'Dr. Muhammad Saiful Islam', 'TUESDAY', '14:00', '15:30', 'UB0802', 'saiful.islam@bracu.ac.bd', 'https://meet.google.com/msi-consult');
    `).run();
  }

  const tsmCount = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'TSM' COLLATE NOCASE").get().c;
  if (tsmCount === 0) {
    db.prepare(`
      INSERT INTO faculty_consultations (faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link)
      VALUES 
        ('TSM', 'Dr. Tareq Sujan', 'MONDAY', '11:00', '12:30', 'UB0821', 'tsm@bracu.ac.bd', NULL),
        ('TSM', 'Dr. Tareq Sujan', 'WEDNESDAY', '11:00', '12:30', 'UB0821', 'tsm@bracu.ac.bd', NULL);
    `).run();
  }
}

/**
 * Initializes a fully isolated test database environment.
 * Sets NODE_ENV='test' and DB_PATH to 'data/test.db' (or ':memory:').
 * Automatically cleans up any previous test database file before running,
 * and provides a cleanup() function to wipe temporary files afterwards.
 *
 * @param {Object} [options]
 * @param {string} [options.dbPath] - Explicit database path (defaults to TEST_DB_PATH or process.env.DB_PATH)
 * @param {boolean} [options.seedBaseline=true] - Whether to populate User #1 baseline courses & slots
 * @returns {{ db: DatabaseSync, cleanup: Function, dbPath: string }}
 */
export function initTestEnvironment(options = {}) {
  const chosenPath = options.dbPath || process.env.DB_PATH || TEST_DB_PATH;
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = chosenPath;

  // Close any existing open database instance
  closeDb();

  // If using a disk file, clean up before starting
  const activePath = getDbPath(chosenPath);
  if (activePath !== ':memory:') {
    cleanDatabaseFiles(activePath);
  }

  // Open the fresh test database connection
  const db = getDb(chosenPath);

  // Initialize schema & migrations
  initSchema(db);

  // Seed baseline fixtures if requested
  if (options.seedBaseline !== false) {
    seedBaselineData(db);
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    closeDb();
    if (activePath !== ':memory:') {
      cleanDatabaseFiles(activePath);
    }
  };

  return { db, cleanup, dbPath: activePath };
}
