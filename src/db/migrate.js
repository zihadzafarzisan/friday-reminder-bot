import { getDb } from './index.js';
import 'dotenv/config';

/**
 * Checks if a column exists in a given table
 */
function hasColumn(db, tableName, columnName) {
  try {
    const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
    return columns.some(col => col.name === columnName);
  } catch {
    return false;
  }
}

/**
 * Checks if a table exists
 */
function hasTable(db, tableName) {
  try {
    const table = db.prepare(`
      SELECT name FROM sqlite_master WHERE type='table' AND name = ?;
    `).get(tableName);
    return Boolean(table);
  } catch {
    return false;
  }
}

/**
 * Executes Phase 5 multi-tenant schema migration
 */
export function runMigration(db = getDb()) {
  console.log('[*] Running Phase 5 Multi-Tenant Migration...');

  // 1. Disable foreign keys during table recreation
  db.exec('PRAGMA foreign_keys = OFF;');

  // 2. Ensure users table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      discord_user_id TEXT UNIQUE NOT NULL,
      pairing_code TEXT UNIQUE,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // 3. Ensure default User #1 exists
  let defaultDiscordId = process.env.DISCORD_USER_ID;
  if (!defaultDiscordId) {
    try {
      const setting = db.prepare("SELECT value FROM settings WHERE key = 'discord_user_id'").get();
      if (setting && setting.value) defaultDiscordId = setting.value.trim();
    } catch {}
  }
  if (!defaultDiscordId) defaultDiscordId = '1328051283080380559';

  const existingDefaultUser = db.prepare('SELECT id, discord_user_id FROM users WHERE id = 1 OR discord_user_id = ?').get(defaultDiscordId);
  if (!existingDefaultUser) {
    db.prepare(`
      INSERT INTO users (id, discord_user_id, pairing_code, created_at)
      VALUES (1, ?, 'DEFAULT1', datetime('now'))
    `).run(defaultDiscordId);
    console.log(`[+] Created default User #1 for Discord ID: ${defaultDiscordId}`);
  } else {
    console.log(`[+] Default User found (ID: ${existingDefaultUser.id}, Discord ID: ${existingDefaultUser.discord_user_id})`);
  }

  // 4. Migrate courses table to include user_id
  if (hasTable(db, 'courses')) {
    if (!hasColumn(db, 'courses', 'user_id')) {
      console.log('[*] Migrating courses table to include user_id...');
      db.exec(`
        CREATE TABLE courses_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          name TEXT,
          section TEXT NOT NULL,
          faculty TEXT,
          room TEXT,
          credits REAL,
          created_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, code, section)
        );

        INSERT INTO courses_new (id, user_id, code, name, section, faculty, room, credits, created_at, updated_at)
        SELECT id, 1, code, name, section, faculty, room, credits, created_at, updated_at
        FROM courses;

        DROP TABLE courses;
        ALTER TABLE courses_new RENAME TO courses;
      `);
      console.log('[+] Courses table migrated successfully.');
    }
  }

  // 5. Migrate routine_slots table to include user_id
  if (hasTable(db, 'routine_slots')) {
    if (!hasColumn(db, 'routine_slots', 'user_id')) {
      console.log('[*] Migrating routine_slots table to include user_id...');
      db.exec(`
        CREATE TABLE routine_slots_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          course_id INTEGER NOT NULL,
          day_of_week TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          room TEXT,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
          UNIQUE(course_id, day_of_week, start_time)
        );

        INSERT INTO routine_slots_new (id, user_id, course_id, day_of_week, start_time, end_time, room, created_at)
        SELECT id, 1, course_id, day_of_week, start_time, end_time, room, created_at
        FROM routine_slots;

        DROP TABLE routine_slots;
        ALTER TABLE routine_slots_new RENAME TO routine_slots;
      `);
      console.log('[+] Routine slots table migrated successfully.');
    }
  }

  // 6. Migrate events table to include user_id
  if (hasTable(db, 'events')) {
    if (!hasColumn(db, 'events', 'user_id')) {
      console.log('[*] Migrating events table to include user_id...');
      db.exec(`
        CREATE TABLE events_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          course_id INTEGER,
          type TEXT NOT NULL,
          title TEXT NOT NULL,
          start_time TEXT NOT NULL,
          end_time TEXT NOT NULL,
          room TEXT,
          is_custom INTEGER DEFAULT 0,
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
          UNIQUE(user_id, course_id, type, start_time)
        );

        INSERT INTO events_new (id, user_id, course_id, type, title, start_time, end_time, room, is_custom, created_at)
        SELECT id, 1, course_id, type, title, start_time, end_time, room, is_custom, created_at
        FROM events;

        DROP TABLE events;
        ALTER TABLE events_new RENAME TO events;
      `);
      console.log('[+] Events table migrated successfully.');
    }
  }

  // 7. Migrate notification_logs table to include user_id
  if (hasTable(db, 'notification_logs')) {
    if (!hasColumn(db, 'notification_logs', 'user_id')) {
      console.log('[*] Migrating notification_logs table to include user_id...');
      db.exec(`
        CREATE TABLE notification_logs_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          event_id TEXT NOT NULL,
          notification_type TEXT NOT NULL,
          sent_at TEXT DEFAULT (datetime('now')),
          status TEXT NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, event_id, notification_type)
        );

        INSERT INTO notification_logs_new (id, user_id, event_id, notification_type, sent_at, status)
        SELECT id, 1, event_id, notification_type, sent_at, status
        FROM notification_logs;

        DROP TABLE notification_logs;
        ALTER TABLE notification_logs_new RENAME TO notification_logs;
      `);
      console.log('[+] Notification logs table migrated successfully.');
    }

    if (!hasColumn(db, 'notification_logs', 'entity_id')) {
      console.log('[*] Migrating notification_logs table to include atomic deduplication schema...');
      db.exec(`
        CREATE TABLE notification_logs_dedup_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL DEFAULT 1,
          entity_id INTEGER NOT NULL DEFAULT 0,
          entity_type TEXT NOT NULL DEFAULT 'event',
          alert_window TEXT NOT NULL DEFAULT 'due',
          notification_date TEXT NOT NULL DEFAULT (date('now')),
          sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          status TEXT DEFAULT 'SENT',
          event_id TEXT,
          notification_type TEXT,
          FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
          UNIQUE(user_id, entity_id, entity_type, alert_window, notification_date)
        );

        INSERT OR IGNORE INTO notification_logs_dedup_new (
          id, user_id, entity_id, entity_type, alert_window, notification_date, sent_at, status, event_id, notification_type
        )
        SELECT 
          id, 
          COALESCE(user_id, 1), 
          CASE 
            WHEN event_id LIKE 'ROUTINE_%' THEN CAST(substr(event_id, 9, instr(substr(event_id, 9), '_') - 1) AS INTEGER)
            ELSE COALESCE(CAST(event_id AS INTEGER), 0)
          END AS entity_id,
          CASE 
            WHEN event_id LIKE 'ROUTINE_%' THEN 'routine_slot'
            ELSE 'event'
          END AS entity_type,
          CASE 
            WHEN notification_type = '30M_BEFORE' THEN '30m'
            WHEN notification_type = '10M_BEFORE' THEN '10m'
            WHEN notification_type = '1H_BEFORE' THEN '1h'
            WHEN notification_type = '24H_BEFORE' THEN '24h'
            ELSE LOWER(notification_type)
          END AS alert_window,
          CASE 
            WHEN event_id LIKE 'ROUTINE_%' THEN substr(event_id, 9 + instr(substr(event_id, 9), '_'))
            ELSE date(COALESCE(sent_at, 'now'))
          END AS notification_date,
          COALESCE(sent_at, CURRENT_TIMESTAMP),
          status,
          event_id,
          notification_type
        FROM notification_logs;

        DROP TABLE notification_logs;
        ALTER TABLE notification_logs_dedup_new RENAME TO notification_logs;
      `);
      console.log('[+] notification_logs migrated to atomic deduplication schema successfully.');
    }
  }

  // 8. Create indexes if courses table exists
  if (hasTable(db, 'courses')) {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);
      CREATE INDEX IF NOT EXISTS idx_routine_slots_user_day ON routine_slots(user_id, day_of_week);
      CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, start_time);
      CREATE INDEX IF NOT EXISTS idx_notification_logs_user_event ON notification_logs(user_id, event_id);
      CREATE INDEX IF NOT EXISTS idx_notification_logs_dedup ON notification_logs(user_id, entity_id, entity_type, alert_window, notification_date);
      CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_user_id);
      CREATE INDEX IF NOT EXISTS idx_users_pairing ON users(pairing_code);
    `);
  }

  // 9. Ensure faculty_consultations table and index exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS faculty_consultations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      faculty_initial TEXT NOT NULL COLLATE NOCASE,
      faculty_name TEXT,
      day_of_week TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      room TEXT,
      contact_email TEXT,
      consultation_link TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_faculty_initial ON faculty_consultations(faculty_initial);
  `);

  // 9b. Seed default faculty consultations if missing
  const msiExists = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'MSI' COLLATE NOCASE").get().c;
  if (msiExists === 0) {
    db.prepare(`
      INSERT INTO faculty_consultations (
        faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link
      ) VALUES 
        ('MSI', 'Dr. Muhammad Saiful Islam', 'SUNDAY', '10:00', '11:30', 'UB0802', 'saiful.islam@bracu.ac.bd', 'https://meet.google.com/msi-consult'),
        ('MSI', 'Dr. Muhammad Saiful Islam', 'TUESDAY', '14:00', '15:30', 'UB0802', 'saiful.islam@bracu.ac.bd', 'https://meet.google.com/msi-consult');
    `).run();
  }

  const tsmExists = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'TSM' COLLATE NOCASE").get().c;
  if (tsmExists === 0) {
    db.prepare(`
      INSERT INTO faculty_consultations (
        faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link
      ) VALUES 
        ('TSM', 'Dr. Tareq Sujan', 'MONDAY', '11:00', '12:30', 'UB0821', 'tsm@bracu.ac.bd', NULL),
        ('TSM', 'Dr. Tareq Sujan', 'WEDNESDAY', '11:00', '12:30', 'UB0821', 'tsm@bracu.ac.bd', NULL);
    `).run();
  }

  // 10. Re-enable foreign keys
  db.exec('PRAGMA foreign_keys = ON;');
  console.log('[+] Phase 5 migration completed successfully.');
}

// Standalone CLI execution
if (process.argv[1] && process.argv[1].endsWith('migrate.js')) {
  try {
    runMigration();
    process.exit(0);
  } catch (err) {
    console.error('[!] Migration failed:', err);
    process.exit(1);
  }
}
