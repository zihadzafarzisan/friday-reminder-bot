import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_RAW_PATH = path.join(ROOT_DIR, 'data', 'schedule_raw.json');

/**
 * Parses double/multi-stringified JSON objects safely
 */
export function parseSerializedJson(data) {
  let parsed = data;
  while (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      break;
    }
  }
  return parsed;
}

/**
 * Ingests a raw schedule payload for a specific user ID
 */
export function normalizeAndIngestPayload(rawContentOrData, db = getDb(), userId = 1) {
  if (!rawContentOrData) {
    throw new Error('No schedule data provided to normalize.');
  }

  const parsedData = parseSerializedJson(rawContentOrData);

  // Support both raw array format and wrapped object format
  const rawCourses = Array.isArray(parsedData)
    ? parsedData
    : (Array.isArray(parsedData?.schedule) ? parsedData.schedule : []);

  if (rawCourses.length === 0) {
    throw new Error('No courses found in the raw schedule payload.');
  }

  const performIngestion = () => {
    // 1. Preserve course associations for manual custom tasks (is_custom = 1)
    const customEventsWithCourses = db.prepare(`
      SELECT e.id, c.code
      FROM events e
      JOIN courses c ON e.course_id = c.id
      WHERE e.user_id = ? AND e.is_custom = 1
    `).all(userId);

    // Detach course_id from custom events so foreign key ON DELETE CASCADE does not delete them
    db.prepare('UPDATE events SET course_id = NULL WHERE user_id = ? AND is_custom = 1').run(userId);

    // 2. Clean previous routine slots, system events, enrolled courses, and notification logs for this user
    db.prepare('DELETE FROM routine_slots WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM events WHERE user_id = ? AND is_custom = 0').run(userId);
    db.prepare('DELETE FROM courses WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM notification_logs WHERE user_id = ?').run(userId);

    const insertCourseStmt = db.prepare(`
      INSERT INTO courses (user_id, code, name, section, faculty, room, credits, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, code, section) DO UPDATE SET
        name = excluded.name,
        faculty = excluded.faculty,
        room = excluded.room,
        credits = excluded.credits,
        updated_at = datetime('now')
      RETURNING id;
    `);

    const insertRoutineStmt = db.prepare(`
      INSERT INTO routine_slots (user_id, course_id, day_of_week, start_time, end_time, room)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(course_id, day_of_week, start_time) DO UPDATE SET
        end_time = excluded.end_time,
        room = excluded.room;
    `);

    const insertEventStmt = db.prepare(`
      INSERT INTO events (user_id, course_id, type, title, start_time, end_time, room, is_custom)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(user_id, course_id, type, start_time) DO UPDATE SET
        end_time = excluded.end_time,
        room = excluded.room,
        title = excluded.title;
    `);

    let coursesInserted = 0;
    let routineSlotsInserted = 0;
    let eventsInserted = 0;
    const importedCourses = [];

    for (const item of rawCourses) {
      const code = item.courseCode?.trim().toUpperCase();
      const section = item.sectionName?.toString().trim();
      if (!code || !section) continue;

      const name = item.name?.trim() || item.courseName?.trim() || null;
      const faculty = item.faculties?.trim() || null;
      const room = item.roomNumber?.trim() || item.roomName?.trim() || null;
      const credits = parseFloat(item.courseCredit) || null;

      // 1. Insert course
      const courseRow = insertCourseStmt.get(userId, code, name, section, faculty, room, credits);
      const courseId = courseRow.id;
      coursesInserted++;
      importedCourses.push({ code, section, name, faculty, room });

      // 2. Parse section schedule
      const secSched = parseSerializedJson(item.sectionSchedule) || {};

      // 3. Insert routine slots (weekly classes)
      const classSchedules = Array.isArray(secSched.classSchedules) ? secSched.classSchedules : [];
      for (const slot of classSchedules) {
        const day = slot.day?.trim().toUpperCase();
        const startTime = slot.startTime?.trim();
        const endTime = slot.endTime?.trim();
        if (!day || !startTime || !endTime) continue;

        // Fallback: slot roomNo -> top-level section roomNumber -> roomName
        const slotRoom = slot.roomNo?.trim() || slot.roomNumber?.trim() || room || null;

        insertRoutineStmt.run(userId, courseId, day, startTime, endTime, slotRoom);
        routineSlotsInserted++;
      }

      // 4. Insert Midterm Exam
      if (secSched.midExamDate && secSched.midExamStartTime) {
        const midDate = secSched.midExamDate.trim();
        const midStart = secSched.midExamStartTime.trim();
        const midEnd = secSched.midExamEndTime?.trim() || midStart;

        const isoStart = `${midDate}T${midStart}+06:00`;
        const isoEnd = `${midDate}T${midEnd}+06:00`;
        const title = `${code} Midterm Exam`;

        insertEventStmt.run(userId, courseId, 'MIDTERM', title, isoStart, isoEnd, room);
        eventsInserted++;
      }

      // 5. Insert Final Exam
      if (secSched.finalExamDate && secSched.finalExamStartTime) {
        const finalDate = secSched.finalExamDate.trim();
        const finalStart = secSched.finalExamStartTime.trim();
        const finalEnd = secSched.finalExamEndTime?.trim() || finalStart;

        const isoStart = `${finalDate}T${finalStart}+06:00`;
        const isoEnd = `${finalDate}T${finalEnd}+06:00`;
        const title = `${code} Final Exam`;

        insertEventStmt.run(userId, courseId, 'FINAL', title, isoStart, isoEnd, room);
        eventsInserted++;
      }
    }

    // Re-link preserved custom events to courses if enrolled
    if (customEventsWithCourses.length > 0) {
      const reattachStmt = db.prepare('UPDATE events SET course_id = ? WHERE id = ?');
      for (const item of customEventsWithCourses) {
        if (!item.code) continue;
        const cleanCode = item.code.trim().toUpperCase();
        const matchedCourse = db.prepare(`
          SELECT id FROM courses WHERE user_id = ? AND UPPER(code) = ? LIMIT 1
        `).get(userId, cleanCode);
        if (matchedCourse) {
          reattachStmt.run(matchedCourse.id, item.id);
        }
      }
    }

    return {
      coursesInserted,
      routineSlotsInserted,
      eventsInserted,
      importedCourses
    };
  };

  if (typeof db.transaction === 'function') {
    return db.transaction(performIngestion)();
  }

  db.exec('BEGIN TRANSACTION;');
  try {
    const result = performIngestion();
    db.exec('COMMIT;');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK;');
    } catch {}
    throw err;
  }
}

/**
 * Normalizes raw BRACU Connect schedule file and upserts into SQLite database
 */
export function normalizeAndIngest(rawFilePath = DEFAULT_RAW_PATH, db = getDb(), userId = 1) {
  if (!fs.existsSync(rawFilePath)) {
    throw new Error(`Raw schedule file not found at: ${rawFilePath}`);
  }

  const rawContent = fs.readFileSync(rawFilePath, 'utf-8');
  return normalizeAndIngestPayload(rawContent, db, userId);
}
