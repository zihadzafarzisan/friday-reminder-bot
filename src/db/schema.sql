-- Database Schema for Academic Reminder Bot (Multi-Tenant)

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_user_id TEXT UNIQUE NOT NULL,
    discord_id TEXT,
    username TEXT,
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
    entity_id INTEGER NOT NULL DEFAULT 0,
    entity_type TEXT NOT NULL DEFAULT 'event',         -- 'routine_slot' | 'event'
    alert_window TEXT NOT NULL DEFAULT 'due',          -- '30m' | '10m' | 'due' | '1h' | '24h'
    notification_date TEXT NOT NULL DEFAULT (date('now')), -- 'YYYY-MM-DD'
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    status TEXT DEFAULT 'SENT',                         -- 'SENT', 'FAILED', 'SKIPPED', 'COMPLETED'
    event_id TEXT,                                      -- String event ID for backwards compatibility
    notification_type TEXT,                             -- Notification type string for backwards compatibility
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    UNIQUE(user_id, entity_id, entity_type, alert_window, notification_date)
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

CREATE TABLE IF NOT EXISTS auth_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT,
    user_id INTEGER,
    code TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    used INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT UNIQUE NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_courses_user ON courses(user_id);
CREATE INDEX IF NOT EXISTS idx_routine_slots_user_day ON routine_slots(user_id, day_of_week);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, start_time);
CREATE INDEX IF NOT EXISTS idx_notification_logs_user_event ON notification_logs(user_id, event_id);
CREATE INDEX IF NOT EXISTS idx_notification_logs_dedup ON notification_logs(user_id, entity_id, entity_type, alert_window, notification_date);
CREATE INDEX IF NOT EXISTS idx_users_discord ON users(discord_user_id);
CREATE INDEX IF NOT EXISTS idx_users_pairing ON users(pairing_code);
CREATE INDEX IF NOT EXISTS idx_faculty_initial ON faculty_consultations(faculty_initial);
CREATE INDEX IF NOT EXISTS idx_auth_codes_code ON auth_codes(code);
CREATE INDEX IF NOT EXISTS idx_auth_codes_user ON auth_codes(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

