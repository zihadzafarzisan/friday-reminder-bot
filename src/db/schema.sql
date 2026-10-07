-- Database Schema for Academic Reminder Bot (Multi-Tenant)

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT UNIQUE NOT NULL,
    pairing_code TEXT UNIQUE,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS courses (
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

CREATE TABLE IF NOT EXISTS routine_slots (
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

CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    course_id INTEGER,
    type TEXT NOT NULL, -- 'MIDTERM', 'FINAL', 'CLASS_INSTANCE', 'QUIZ', 'ASSIGNMENT', 'MAKEUP', 'LAB_TASK'
    title TEXT NOT NULL,
    start_time TEXT NOT NULL, -- ISO-8601 with Asia/Dhaka (+06:00) offset
    end_time TEXT NOT NULL,   -- ISO-8601 with Asia/Dhaka (+06:00) offset
    room TEXT,
    is_custom INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (course_id) REFERENCES courses(id) ON DELETE CASCADE,
    UNIQUE(user_id, course_id, type, start_time)
);

CREATE TABLE IF NOT EXISTS notification_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event_id TEXT NOT NULL,          -- String event ID (e.g. '1', or 'ROUTINE_<slotId>_<YYYY-MM-DD>')
    notification_type TEXT NOT NULL, -- '24H_BEFORE', '1H_BEFORE', '30M_BEFORE', '10M_BEFORE'
    sent_at TEXT DEFAULT (datetime('now')),
    status TEXT NOT NULL,            -- 'SENT', 'FAILED', 'SKIPPED', 'COMPLETED'
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, event_id, notification_type)
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);

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

CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_routine_slots_user_day ON routine_slots(user_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_event ON notification_logs(user_id, event_id);
CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_users_pairing ON users(pairing_code);
CREATE INDEX IF NOT EXISTS idx_faculty_initial ON faculty_consultations(faculty_initial);
