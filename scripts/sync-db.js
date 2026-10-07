import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../src/db/index.js';
import { normalizeAndIngest } from '../src/normalize.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT_DIR, 'data', 'academic.db');
const RAW_PATH = path.join(ROOT_DIR, 'data', 'schedule_raw.json');

async function main() {
  console.log('====================================================');
  console.log('  BRACU CONNECT — PHASE 2: DATABASE SYNC');
  console.log('====================================================');
  console.log(`[+] Database target: ${DB_PATH}`);
  console.log(`[+] Raw data source: ${RAW_PATH}`);

  const db = getDb(DB_PATH);
  console.log('[+] Database initialized & schema migrated successfully.');

  console.log('[+] Ingesting and normalizing schedule data...');
  const stats = normalizeAndIngest(RAW_PATH, db);
  console.log(`[+] Ingestion complete: ${stats.coursesInserted} courses processed.`);

  // 1. Query Courses
  const courses = db.prepare(`
    SELECT id, code, name, section, faculty, room, credits
    FROM courses
    WHERE user_id = 1
    ORDER BY code ASC;
  `).all();

  console.log('\n--- STORED COURSES (' + courses.length + ') ---');
  console.table(courses.map(c => ({
    ID: c.id,
    Code: c.code,
    Section: c.section,
    Faculty: c.faculty || 'N/A',
    Room: c.room || 'N/A',
    Credits: c.credits
  })));

  // 2. Query Routine Slots
  const slots = db.prepare(`
    SELECT c.code, r.day_of_week, r.start_time, r.end_time, r.room
    FROM routine_slots r
    JOIN courses c ON r.course_id = c.id
    WHERE r.user_id = 1
    ORDER BY 
      CASE r.day_of_week
        WHEN 'SUNDAY' THEN 1
        WHEN 'MONDAY' THEN 2
        WHEN 'TUESDAY' THEN 3
        WHEN 'WEDNESDAY' THEN 4
        WHEN 'THURSDAY' THEN 5
        WHEN 'FRIDAY' THEN 6
        WHEN 'SATURDAY' THEN 7
      END,
      r.start_time ASC;
  `).all();

  console.log('\n--- WEEKLY ROUTINE SLOTS (' + slots.length + ') ---');
  console.table(slots.map(s => ({
    Course: s.code,
    Day: s.day_of_week,
    Start: s.start_time,
    End: s.end_time,
    Room: s.room || 'N/A'
  })));

  // 3. Query Concrete Events (Exams)
  const events = db.prepare(`
    SELECT c.code, e.type, e.title, e.start_time, e.end_time, e.room
    FROM events e
    JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = 1
    ORDER BY e.start_time ASC;
  `).all();

  console.log('\n--- CONCRETE EXAM EVENTS (' + events.length + ') ---');
  console.table(events.map(e => ({
    Course: e.code,
    Type: e.type,
    Title: e.title,
    'Start (Asia/Dhaka)': e.start_time,
    'End (Asia/Dhaka)': e.end_time,
    Room: e.room || 'N/A'
  })));

  console.log('\n====================================================');
  console.log('  PHASE 2 SUMMARY');
  console.log('====================================================');
  console.log(`[+] Total Courses:       ${courses.length}`);
  console.log(`[+] Weekly Class Slots:  ${slots.length}`);
  console.log(`[+] Concrete Exam Events: ${events.length}`);
  console.log('====================================================\n');
}

main().catch(err => {
  console.error('\n[ERROR] Database sync failed:');
  console.error(err);
  process.exit(1);
});
