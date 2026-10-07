import express from 'express';
import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { getDb } from './db/index.js';
import { getStoredDiscordUserId, getDhakaContext } from './reminder-engine.js';
import { normalizeAndIngest, normalizeAndIngestPayload } from './normalize.js';
import { getDiscordClient, sendDM, buildTestEmbed, buildExamAlertEmbed, buildTaskAlertEmbed } from './bot.js';
import { buildTaskActionRow } from './commands/handlers.js';
import { EmbedBuilder } from 'discord.js';
import { initBot, stopBot } from './index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

export const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://friday.alwaysdata.net';

const DAYS_OF_WEEK = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];

/**
 * Normalizes 12h or 24h time strings to standard 24h 'HH:MM' (e.g. '10:00 AM' -> '10:00', '02:00 PM' -> '14:00')
 */
export function normalizeTimeTo24h(timeStr) {
  if (!timeStr) return '';
  const trimmed = String(timeStr).trim();
  const match12 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = match12[2];
    const meridiem = match12[3].toUpperCase();
    if (meridiem === 'PM' && h < 12) h += 12;
    if (meridiem === 'AM' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24) {
    const h = String(match24[1]).padStart(2, '0');
    const m = match24[2];
    return `${h}:${m}`;
  }
  return trimmed;
}

/**
 * Parses multiline batch consultation text:
 * Supports:
 * - MSI, Dr. Muhammad S. Islam, Sunday, 10:00 AM, 11:30 AM, UB0802
 * - MSI, Sunday, 10:00 AM, 11:30 AM, UB0802
 */
export function parseBulkConsultationsText(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0 && !l.startsWith('#'));
  const slots = [];

  for (const line of lines) {
    const parts = line.split(/[,;\t]/).map(p => p.trim());
    if (parts.length < 4) continue;

    const initial = parts[0];
    let name = null;
    let day = null;
    let startTime = null;
    let endTime = null;
    let room = null;
    let extra1 = null;

    if (DAYS_OF_WEEK.includes(parts[1].toUpperCase())) {
      day = parts[1].toUpperCase();
      startTime = parts[2];
      endTime = parts[3];
      room = parts[4] || null;
      extra1 = parts[5] || null;
    } else {
      name = parts[1] || null;
      day = parts[2] ? parts[2].toUpperCase() : '';
      startTime = parts[3] || '';
      endTime = parts[4] || '';
      room = parts[5] || null;
      extra1 = parts[6] || null;
    }

    if (!initial || !day || !startTime || !endTime) continue;

    let consultation_link = null;
    let contact_email = null;

    if (room && /^https?:\/\//i.test(room)) {
      consultation_link = room;
      room = null;
    }

    if (extra1) {
      if (extra1.includes('@')) {
        contact_email = extra1;
      } else if (/^https?:\/\//i.test(extra1)) {
        consultation_link = extra1;
      }
    }

    slots.push({
      faculty_initial: initial.toUpperCase(),
      faculty_name: name,
      day_of_week: day,
      start_time: normalizeTimeTo24h(startTime),
      end_time: normalizeTimeTo24h(endTime),
      room,
      consultation_link,
      contact_email
    });
  }

  return slots;
}

/**
 * Resolves the authenticated user from the session cookie.
 * Returns the user object or null if not authenticated.
 */
export function getSessionUser(req, db) {
  const token = req.cookies?.friday_session;
  if (!token) return null;

  try {
    const session = db.prepare(`
      SELECT s.*, u.id as uid, u.discord_user_id, u.username, u.pairing_code
      FROM sessions s
      JOIN users u ON s.user_id = u.id
      WHERE s.token = ? AND s.expires_at > datetime('now')
    `).get(token);

    if (!session) return null;

    return {
      id: session.uid,
      discord_user_id: session.discord_user_id,
      username: session.username,
      pairing_code: session.pairing_code
    };
  } catch {
    return null;
  }
}

/**
 * Creates a new session for the given user and sets the cookie on the response.
 * Sessions expire after 30 days.
 */
export function createSession(userId, res, db) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  // Clean up any expired sessions for this user
  try {
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND expires_at <= datetime("now")').run(userId);
  } catch {}

  db.prepare(`
    INSERT INTO sessions (user_id, token, expires_at)
    VALUES (?, ?, ?)
  `).run(userId, token, expiresAt);

  res.cookie('friday_session', token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    path: '/'
  });

  return token;
}

/**
 * Extracts the targeted user_id. Prioritizes authenticated session for strict tenant isolation.
 */
export function getRequestUserId(req, db) {
  // Priority 1: Authenticated session (strongest isolation, cannot be overridden by params)
  if (req.userId) {
    return req.userId;
  }
  if (req.authenticatedUser) {
    return req.authenticatedUser.id;
  }
  const sessionUser = getSessionUser(req, db);
  if (sessionUser) {
    req.authenticatedUser = sessionUser;
    req.userId = sessionUser.id;
    return sessionUser.id;
  }
  // Priority 2: Query param (for test environments or explicit overrides in tests)
  if (req.query?.user_id) {
    const parsed = parseInt(req.query.user_id, 10);
    if (!isNaN(parsed)) return parsed;
  }
  // Priority 3: Header (for test environments or explicit overrides in tests)
  if (req.headers && req.headers['x-user-id']) {
    const parsed = parseInt(req.headers['x-user-id'], 10);
    if (!isNaN(parsed)) return parsed;
  }
  return 1;
}

/**
 * Strict authentication middleware: ensures req.userId is extracted from session
 * and rejects unauthenticated API requests immediately.
 */
export function requireAuth(req, res, next) {
  // Public routes that bypass auth:
  if (
    req.path === '/ping' ||
    req.path === '/login' ||
    req.path === '/logout' ||
    req.path.startsWith('/auth/') ||
    req.path.startsWith('/api/auth/') ||
    req.path === '/user/import-schedule' ||
    req.path === '/api/user/import-schedule'
  ) {
    return next();
  }

  const db = getDb();
  const sessionUser = req.signedCookies?.friday_session || req.cookies?.friday_session;

  if (!sessionUser && !req.authenticatedUser) {
    // In test environment without session cookie and without enforce-auth, allow legacy tests
    if (process.env.NODE_ENV === 'test' && !req.headers['x-enforce-auth']) {
      req.userId = getRequestUserId(req, db);
      return next();
    }

    if (req.path.startsWith('/api/') || req.baseUrl === '/api') {
      return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/login');
  }

  // Resolve user
  let user = req.authenticatedUser || getSessionUser(req, db);
  if (!user && sessionUser) {
    const parsedId = parseInt(sessionUser, 10);
    if (!isNaN(parsedId)) {
      user = db.prepare('SELECT id, discord_user_id, username, pairing_code FROM users WHERE id = ?').get(parsedId);
    }
  }

  if (!user) {
    if (process.env.NODE_ENV === 'test' && !req.headers['x-enforce-auth']) {
      req.userId = getRequestUserId(req, db);
      return next();
    }
    if (req.path.startsWith('/api/') || req.baseUrl === '/api') {
      return res.status(401).json({ success: false, error: 'Unauthorized. Please log in.' });
    }
    return res.redirect('/login');
  }

  req.authenticatedUser = user;
  req.userId = user.id;
  next();
}

export function createServer() {
  const app = express();

  // Ultra-lightweight keepalive ping (must be first, supports GET and HEAD)
  app.all('/ping', (req, res) => {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(200).send('OK');
  });

  const db = getDb();

  // CORS Middleware for Bookmarklet access
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-User-Id');
    if (req.method === 'OPTIONS') {
      return res.sendStatus(200);
    }
    next();
  });

  app.use(express.json({ limit: '10mb' }));
  app.use(cookieParser());

  // Attach session user to req if present
  app.use((req, res, next) => {
    const user = getSessionUser(req, db);
    if (user) {
      req.authenticatedUser = user;
      req.userId = user.id;
    }
    next();
  });

  // Serve static assets without defaulting to index.html (so / is protected)
  app.use(express.static(PUBLIC_DIR, { index: false }));

  // GET /login - Serve login landing page or redirect to / if already authenticated
  app.get('/login', (req, res) => {
    if (req.authenticatedUser) {
      return res.redirect('/');
    }
    res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
  });

  // GET / - Dashboard home, requires authentication
  app.get('/', (req, res) => {
    if (!req.authenticatedUser) {
      return res.redirect('/login');
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  // GET & POST /logout - Terminate session & redirect to /login
  app.all('/logout', (req, res) => {
    try {
      const token = req.cookies?.friday_session;
      if (token) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
      res.clearCookie('friday_session', { path: '/' });
    } catch {}
    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
      return res.json({ success: true, message: 'Logged out successfully.' });
    }
    return res.redirect('/login');
  });

  // POST /api/auth/login - Validate one-time passkey & create session
  app.post('/api/auth/login', (req, res) => {
    try {
      const code = req.body?.code || req.body?.passkey;
      if (!code || !String(code).trim()) {
        return res.status(400).json({ success: false, error: 'Authentication passkey is required.' });
      }

      const cleanCode = String(code).trim().toUpperCase();

      const authCode = db.prepare(`
        SELECT * FROM auth_codes
        WHERE code = ? AND used = 0 AND expires_at > datetime('now')
      `).get(cleanCode);

      if (!authCode) {
        return res.status(401).json({
          success: false,
          error: 'Invalid or expired passkey. Please generate a new one with /login on Discord.'
        });
      }

      // Resolve matching user by user_id, discord_id, or discord_user_id
      let user = null;
      if (authCode.user_id) {
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(authCode.user_id);
      }
      if (!user && authCode.discord_id) {
        user = db.prepare('SELECT * FROM users WHERE discord_id = ? OR discord_user_id = ?').get(authCode.discord_id, authCode.discord_id);
      }
      if (!user) {
        // Fallback: create user if discord_id exists
        const discordId = authCode.discord_id || '1328051283080380559';
        const info = db.prepare(`
          INSERT INTO users (discord_user_id, discord_id, username, created_at)
          VALUES (?, ?, 'Student', datetime('now'))
        `).run(discordId, discordId);
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }

      // Mark code as used
      db.prepare('UPDATE auth_codes SET used = 1 WHERE id = ?').run(authCode.id);

      // Create session
      createSession(user.id, res, db);

      res.json({
        success: true,
        message: 'Login successful!',
        user: {
          id: user.id,
          username: user.username || 'Student',
          discord_user_id: user.discord_user_id || user.discord_id
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // POST /api/auth/logout - Destroy session & clear cookie
  app.post('/api/auth/logout', (req, res) => {
    try {
      const token = req.cookies?.friday_session;
      if (token) {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      }
      res.clearCookie('friday_session', { path: '/' });
      res.json({ success: true, message: 'Logged out successfully.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // GET /api/auth/me - Verify current session
  app.get('/api/auth/me', (req, res) => {
    try {
      const user = req.authenticatedUser || getSessionUser(req, db);
      if (!user) {
        return res.status(401).json({ success: false, authenticated: false });
      }
      res.json({
        success: true,
        authenticated: true,
        user: {
          id: user.id,
          username: user.username || 'Student',
          discord_user_id: user.discord_user_id
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Route protection middleware for /api/*
  app.use('/api', requireAuth);

  // 1. GET /api/users - List all registered student profiles
  app.get('/api/users', (req, res) => {
    try {
      if (req.authenticatedUser) {
        const users = db.prepare(`
          SELECT 
            u.id, 
            u.discord_user_id, 
            u.pairing_code, 
            u.created_at,
            (SELECT count(*) FROM courses WHERE user_id = u.id) as courses_count,
            (SELECT count(*) FROM routine_slots WHERE user_id = u.id) as routine_slots_count,
            (SELECT count(*) FROM events WHERE user_id = u.id) as events_count
          FROM users u
          WHERE u.id = ?
        `).all(req.authenticatedUser.id);
        return res.json({ success: true, data: users });
      }

      const users = db.prepare(`
        SELECT 
          u.id, 
          u.discord_user_id, 
          u.pairing_code, 
          u.created_at,
          (SELECT count(*) FROM courses WHERE user_id = u.id) as courses_count,
          (SELECT count(*) FROM routine_slots WHERE user_id = u.id) as routine_slots_count,
          (SELECT count(*) FROM events WHERE user_id = u.id) as events_count
        FROM users u
        ORDER BY u.id ASC;
      `).all();

      res.json({ success: true, data: users });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. GET /api/status - Bot & DB metrics (global + user-scoped)
  app.get('/api/status', (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);

      const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
      const courseCount = db.prepare('SELECT count(*) as count FROM courses WHERE user_id = ?').get(targetUserId).count;
      const slotCount = db.prepare('SELECT count(*) as count FROM routine_slots WHERE user_id = ?').get(targetUserId).count;
      const eventCount = db.prepare('SELECT count(*) as count FROM events WHERE user_id = ?').get(targetUserId).count;
      const logCount = db.prepare('SELECT count(*) as count FROM notification_logs WHERE user_id = ?').get(targetUserId).count;

      const lastCourse = db.prepare('SELECT updated_at FROM courses WHERE user_id = ? ORDER BY updated_at DESC LIMIT 1').get(targetUserId);
      const lastSyncedRow = db.prepare("SELECT value FROM settings WHERE key = 'last_synced_at'").get();
      const userSyncRow = db.prepare('SELECT value FROM settings WHERE key = ?').get(`last_synced_user_${targetUserId}`);

      const userRow = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
      const storedUserId = userRow?.discord_user_id || getStoredDiscordUserId(db);
      const passcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'dashboard_passcode'").get();

      const hasDiscordConfig = Boolean(
        process.env.DISCORD_BOT_TOKEN &&
        process.env.DISCORD_BOT_TOKEN !== 'your_discord_bot_token_here' &&
        storedUserId &&
        storedUserId !== 'your_discord_user_id_here'
      );

      const syncTime = userSyncRow?.value || lastSyncedRow?.value || lastCourse?.updated_at || null;

      res.json({
        success: true,
        data: {
          timezone: process.env.TIMEZONE || 'Asia/Dhaka',
          activeUserId: targetUserId,
          usersCount: userCount,
          coursesCount: courseCount,
          routineSlotsCount: slotCount,
          eventsCount: eventCount,
          notificationsSent: logCount,
          lastSync: syncTime,
          last_synced_at: syncTime,
          botConfigured: hasDiscordConfig,
          discordUserId: storedUserId || null,
          pairingCode: userRow?.pairing_code || null,
          hasPasscode: Boolean(passcodeRow && passcodeRow.value)
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. GET /api/courses - List courses for dropdowns
  app.get('/api/courses', (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);
      const courses = db.prepare(`
        SELECT id, code, name, section, faculty, room, credits
        FROM courses
        WHERE user_id = ?
        ORDER BY code ASC;
      `).all(targetUserId);
      res.json({ success: true, data: courses });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. GET /api/routine - Weekly timetable grouped by day
  app.get('/api/routine', (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);
      const slots = db.prepare(`
        SELECT 
          r.id,
          r.course_id,
          r.day_of_week,
          r.start_time,
          r.end_time,
          COALESCE(r.room, c.room) AS room,
          c.code,
          c.name,
          c.section,
          c.faculty,
          c.credits
        FROM routine_slots r
        JOIN courses c ON r.course_id = c.id
        WHERE r.user_id = ?
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
      `).all(targetUserId);

      const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY'];
      const grouped = {};
      for (const d of days) grouped[d] = [];

      for (const slot of slots) {
        if (!grouped[slot.day_of_week]) {
          grouped[slot.day_of_week] = [];
        }
        grouped[slot.day_of_week].push(slot);
      }

      res.json({ success: true, data: { slots, grouped } });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. GET /api/events - Discrete events
  app.get('/api/events', (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);
      const events = db.prepare(`
        SELECT 
          e.id,
          e.course_id,
          e.type,
          e.title,
          e.start_time,
          e.end_time,
          COALESCE(e.room, c.room) AS room,
          e.is_custom,
          e.created_at,
          c.code AS course_code,
          c.name AS course_name,
          c.section AS course_section,
          c.faculty AS course_faculty
        FROM events e
        LEFT JOIN courses c ON e.course_id = c.id
        WHERE e.user_id = ?
        ORDER BY e.start_time ASC;
      `).all(targetUserId);

      res.json({ success: true, data: events });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6. POST /api/events - Create custom event
  app.post('/api/events', (req, res) => {
    try {
      const targetUserId = req.authenticatedUser ? req.authenticatedUser.id : (req.body.user_id ? parseInt(req.body.user_id, 10) : getRequestUserId(req, db));
      const { course_id, type, title, start_time, end_time, room } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Title is required.' });
      }
      if (!type || !type.trim()) {
        return res.status(400).json({ success: false, error: 'Event type is required.' });
      }
      if (!start_time || !start_time.trim()) {
        return res.status(400).json({ success: false, error: 'Start time is required.' });
      }

      const formatOffset = (val) => {
        if (!val) return val;
        val = val.trim();
        if (!val.includes('+') && !val.includes('Z')) {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(val)) return `${val}:00+06:00`;
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(val)) return `${val}+06:00`;
          return `${val}+06:00`;
        }
        return val;
      };

      const formattedStart = formatOffset(start_time);
      const formattedEnd = end_time ? formatOffset(end_time) : formattedStart;

      const courseId = course_id ? parseInt(course_id, 10) : null;
      const cleanRoom = room?.trim() || null;
      const cleanType = type.trim().toUpperCase();

      const insertStmt = db.prepare(`
        INSERT INTO events (user_id, course_id, type, title, start_time, end_time, room, is_custom)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        RETURNING id;
      `);

      const result = insertStmt.get(targetUserId, courseId, cleanType, title.trim(), formattedStart, formattedEnd, cleanRoom);

      res.json({
        success: true,
        message: 'Event created successfully.',
        data: { id: result.id }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 7. PUT /api/events/:id - Update custom event
  app.put('/api/events/:id', (req, res) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      if (isNaN(eventId)) {
        return res.status(400).json({ success: false, error: 'Invalid event ID.' });
      }

      const targetUserId = getRequestUserId(req, db);
      const existing = db.prepare('SELECT id, is_custom, title, user_id FROM events WHERE id = ?').get(eventId);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }

      if (!existing.is_custom) {
        return res.status(403).json({ success: false, error: 'Cannot edit official university exam schedule.' });
      }

      if (existing.user_id !== targetUserId) {
        return res.status(403).json({ success: false, error: 'Access denied: You cannot edit another student\'s event.' });
      }

      const { course_id, type, title, start_time, end_time, room } = req.body;

      if (!title || !title.trim()) {
        return res.status(400).json({ success: false, error: 'Title is required.' });
      }
      if (!type || !type.trim()) {
        return res.status(400).json({ success: false, error: 'Event type is required.' });
      }
      if (!start_time || !start_time.trim()) {
        return res.status(400).json({ success: false, error: 'Start time is required.' });
      }

      const formatOffset = (val) => {
        if (!val) return val;
        val = val.trim();
        if (!val.includes('+') && !val.includes('Z')) {
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(val)) return `${val}:00+06:00`;
          if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(val)) return `${val}+06:00`;
          return `${val}+06:00`;
        }
        return val;
      };

      const formattedStart = formatOffset(start_time);
      const formattedEnd = end_time ? formatOffset(end_time) : formattedStart;
      const courseId = course_id ? parseInt(course_id, 10) : null;
      const cleanRoom = room?.trim() || null;
      const cleanType = type.trim().toUpperCase();

      db.prepare(`
        UPDATE events 
        SET course_id = ?, type = ?, title = ?, start_time = ?, end_time = ?, room = ?
        WHERE id = ?
      `).run(courseId, cleanType, title.trim(), formattedStart, formattedEnd, cleanRoom, eventId);

      const updated = db.prepare(`
        SELECT 
          e.id, e.user_id, e.course_id, e.type, e.title, e.start_time, e.end_time, e.room, e.is_custom,
          c.code AS course_code, c.name AS course_name, c.section AS course_section
        FROM events e
        LEFT JOIN courses c ON e.course_id = c.id
        WHERE e.id = ?
      `).get(eventId);

      res.json({
        success: true,
        message: 'Event updated successfully.',
        data: updated
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 8. DELETE /api/events/:id - Remove custom event
  app.delete('/api/events/:id', (req, res) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      if (isNaN(eventId)) {
        return res.status(400).json({ success: false, error: 'Invalid event ID.' });
      }

      const targetUserId = getRequestUserId(req, db);
      const event = db.prepare('SELECT id, is_custom, title, user_id FROM events WHERE id = ?').get(eventId);
      if (!event) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }

      if (!event.is_custom) {
        return res.status(403).json({ success: false, error: 'Cannot delete system-synced university exam events.' });
      }

      if (event.user_id !== targetUserId) {
        return res.status(403).json({ success: false, error: 'Access denied: You cannot delete another student\'s event.' });
      }

      db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
      res.json({ success: true, message: `Custom event "${event.title}" removed.` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 9. POST /api/user/import-schedule - Web Ingestion Portal for student schedules
  app.post('/api/user/import-schedule', async (req, res) => {
    try {
      const { pairing_code, schedule_data, schedule } = req.body;
      const rawPayload = schedule_data || schedule || req.body;

      if (!pairing_code || !String(pairing_code).trim()) {
        return res.status(400).json({
          success: false,
          error: 'Pairing code is required. Run /start on Discord to obtain your pairing code.'
        });
      }

      const cleanCode = String(pairing_code).trim().toUpperCase();
      const user = db.prepare('SELECT * FROM users WHERE UPPER(pairing_code) = ?').get(cleanCode);

      if (!user) {
        return res.status(404).json({
          success: false,
          error: `Invalid pairing code "${cleanCode}". Please run /start on Discord to link your account.`
        });
      }

      // Ingest payload for this specific user
      const result = normalizeAndIngestPayload(rawPayload, db, user.id);

      // Record sync timestamp for this user
      const { isoDhaka } = getDhakaContext(new Date());
      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now');
      `).run(`last_synced_user_${user.id}`, isoDhaka);

      // Dispatch welcoming Discord DM to this student
      let dmDispatched = false;
      if (process.env.DISCORD_BOT_TOKEN && user.discord_user_id) {
        try {
          const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN, { attachListeners: false });
          const courseLines = result.importedCourses.map(c => 
            `• **${c.code}** (Sec ${c.section})${c.faculty ? ` • 👨‍🏫 ${c.faculty}` : ''}${c.room ? ` • 📍 ${c.room}` : ''}`
          ).join('\n') || 'Courses imported';

          const welcomeEmbed = new EmbedBuilder()
            .setTitle('🎉 BRACU Routine Imported Successfully!')
            .setDescription(`Welcome! Your class routine and exam calendar have been linked to FRIDAY.`)
            .setColor(0x10B981)
            .addFields(
              {
                name: `📚 Enrolled Courses (${result.coursesInserted})`,
                value: courseLines.length > 1024 ? courseLines.substring(0, 1020) + '...' : courseLines,
                inline: false
              },
              {
                name: '⏰ Class Sessions',
                value: `**${result.routineSlotsInserted}** session(s) / week`,
                inline: true
              },
              {
                name: '🎯 Exams Detected',
                value: `**${result.eventsInserted}** Midterm/Final(s)`,
                inline: true
              }
            )
            .setFooter({ text: 'FRIDAY Reminder Bot • Multi-Tenant • Asia/Dhaka (+06:00)' })
            .setTimestamp();

          const dmRes = await sendDM(user.discord_user_id, { embeds: [welcomeEmbed] }, client);
          dmDispatched = dmRes.success;
        } catch (err) {
          console.warn(`[!] Welcome DM notice for user ${user.discord_user_id}:`, err.message);
        }
      }

      res.json({
        success: true,
        message: `Schedule successfully imported for student (Discord: ${user.discord_user_id})!`,
        user_id: user.id,
        discord_user_id: user.discord_user_id,
        dm_sent: dmDispatched,
        data: result
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 10. GET /api/settings - Read settings
  app.get('/api/settings', (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);

      const discordUserId = user?.discord_user_id || getStoredDiscordUserId(db);
      const passcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'dashboard_passcode'").get();
      const userNameRow = db.prepare("SELECT value FROM settings WHERE key = 'user_name'").get();

      res.json({
        success: true,
        data: {
          user_id: targetUserId,
          pairing_code: user?.pairing_code || '',
          discord_user_id: discordUserId || '',
          has_passcode: Boolean(passcodeRow && passcodeRow.value),
          user_name: userNameRow?.value || 'Student'
        }
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 11. POST /api/settings - Update settings
  app.post('/api/settings', (req, res) => {
    try {
      const { discord_user_id, passcode, user_name, user_id } = req.body;
      const targetUserId = req.authenticatedUser ? req.authenticatedUser.id : (user_id ? parseInt(user_id, 10) : getRequestUserId(req, db));

      const upsertStmt = db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now');
      `);

      if (discord_user_id !== undefined) {
        const cleanUserId = discord_user_id ? String(discord_user_id).trim() : '';
        upsertStmt.run('discord_user_id', cleanUserId);
        // Also update users table for this user
        if (cleanUserId) {
          db.prepare('UPDATE users SET discord_user_id = ? WHERE id = ?').run(cleanUserId, targetUserId);
        }
      }

      if (user_name !== undefined) {
        const cleanName = user_name ? String(user_name).trim() : '';
        upsertStmt.run('user_name', cleanName);
      }

      if (passcode !== undefined) {
        const cleanPass = passcode ? String(passcode).trim() : '';
        if (!cleanPass) {
          db.prepare("DELETE FROM settings WHERE key = 'dashboard_passcode'").run();
        } else {
          upsertStmt.run('dashboard_passcode', cleanPass);
        }
      }

      res.json({ success: true, message: 'Settings saved successfully.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 12. POST /api/auth/verify - Verify dashboard passcode
  app.post('/api/auth/verify', (req, res) => {
    try {
      const passcodeRow = db.prepare("SELECT value FROM settings WHERE key = 'dashboard_passcode'").get();
      if (!passcodeRow || !passcodeRow.value) {
        return res.json({ success: true, locked: false, verified: true });
      }

      const input = req.body.passcode ? String(req.body.passcode).trim() : '';
      if (input === passcodeRow.value.trim()) {
        return res.json({ success: true, locked: true, verified: true });
      } else {
        return res.status(401).json({ success: false, error: 'Incorrect passcode. Access denied.' });
      }
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 13. POST /api/alerts/test - Manual connectivity test ping to Discord
  app.post('/api/alerts/test', async (req, res) => {
    try {
      const targetUserId = getRequestUserId(req, db);
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(targetUserId);
      const targetDiscordId = user?.discord_user_id || getStoredDiscordUserId(db);

      if (!targetDiscordId) {
        return res.status(400).json({ success: false, error: 'No Discord User ID configured. Please configure in Settings or run /start on Discord.' });
      }
      if (!process.env.DISCORD_BOT_TOKEN) {
        return res.status(400).json({ success: false, error: 'DISCORD_BOT_TOKEN is not configured in .env.' });
      }

      const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN, { attachListeners: false });
      const embed = buildTestEmbed(client.user?.tag || 'FRIDAY');
      const sendResult = await sendDM(targetDiscordId, { embeds: [embed] }, client);

      const testKey = `TEST_PING_${Date.now()}`;
      const status = sendResult.success ? 'SENT' : 'FAILED';
      const { dateStr } = getDhakaContext(new Date());
      db.prepare(`
        INSERT INTO notification_logs (user_id, entity_id, entity_type, alert_window, notification_date, status, event_id, notification_type)
        VALUES (?, 0, 'test', ?, ?, ?, ?, 'TEST_ALERT')
        ON CONFLICT(user_id, entity_id, entity_type, alert_window, notification_date) DO UPDATE SET
          sent_at = datetime('now'),
          status = excluded.status;
      `).run(targetUserId, `ping_${Date.now()}`, dateStr, status, testKey);

      if (!sendResult.success) {
        return res.status(500).json({ success: false, error: `Failed to dispatch Discord DM: ${sendResult.error}` });
      }

      res.json({ success: true, message: `Test alert successfully sent to Discord user (${targetDiscordId})!` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 14. POST /api/events/:id/test-alert - Trigger immediate test alert for a specific event
  app.post('/api/events/:id/test-alert', async (req, res) => {
    try {
      const eventId = parseInt(req.params.id, 10);
      if (isNaN(eventId)) {
        return res.status(400).json({ success: false, error: 'Invalid event ID.' });
      }

      const ev = db.prepare(`
        SELECT 
          e.*, 
          c.code, c.name, c.section, c.faculty, c.room AS course_room
        FROM events e
        LEFT JOIN courses c ON e.course_id = c.id
        WHERE e.id = ?;
      `).get(eventId);

      if (!ev) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }

      const targetUserId = getRequestUserId(req, db);
      if (ev.user_id !== targetUserId) {
        return res.status(403).json({ success: false, error: 'Access denied: Event belongs to another student.' });
      }

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ev.user_id);
      const targetDiscordId = user?.discord_user_id || getStoredDiscordUserId(db);

      if (!targetDiscordId) {
        return res.status(400).json({ success: false, error: 'No Discord User ID configured for this event.' });
      }
      if (!process.env.DISCORD_BOT_TOKEN) {
        return res.status(400).json({ success: false, error: 'DISCORD_BOT_TOKEN is not configured in .env.' });
      }

      const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN, { attachListeners: false });
      const isExam = ev.type === 'MIDTERM' || ev.type === 'FINAL';
      const course = ev.code ? { code: ev.code, name: ev.name, section: ev.section, faculty: ev.faculty } : null;
      const eventData = {
        type: ev.type,
        title: ev.title,
        start_time: ev.start_time,
        end_time: ev.end_time,
        room: ev.room || ev.course_room || 'TBA'
      };

      const embed = (isExam && course)
        ? buildExamAlertEmbed(course, eventData, 'TEST_ALERT', 'Scheduled (Test Alert)')
        : buildTaskAlertEmbed(course, eventData, 'TEST_ALERT', 'Scheduled (Test Alert)');

      const components = ev.is_custom ? [buildTaskActionRow(ev.id)] : [];
      const sendResult = await sendDM(targetDiscordId, { embeds: [embed], components }, client);
      const testKey = `MANUAL_TEST_${ev.id}_${Date.now()}`;
      const status = sendResult.success ? 'SENT' : 'FAILED';
      const { dateStr } = getDhakaContext(new Date());

      db.prepare(`
        INSERT INTO notification_logs (user_id, entity_id, entity_type, alert_window, notification_date, status, event_id, notification_type)
        VALUES (?, ?, 'event', ?, ?, ?, ?, 'TEST_ALERT')
        ON CONFLICT(user_id, entity_id, entity_type, alert_window, notification_date) DO UPDATE SET
          sent_at = datetime('now'),
          status = excluded.status;
      `).run(ev.user_id, ev.id, `manual_${Date.now()}`, dateStr, status, testKey);

      if (!sendResult.success) {
        return res.status(500).json({ success: false, error: `Failed to dispatch alert: ${sendResult.error}` });
      }

      res.json({ success: true, message: `Alert for "${ev.title}" sent to Discord user (${targetDiscordId})!` });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 15. GET /api/logs - Recent notification dispatch logs
  app.get('/api/logs', (req, res) => {
    try {
      const targetUserId = req.authenticatedUser ? req.authenticatedUser.id : (req.query.user_id ? parseInt(req.query.user_id, 10) : null);
      const query = targetUserId
        ? 'SELECT n.id, n.user_id, n.event_id, n.notification_type, n.sent_at, n.status, e.title AS event_title, e.type AS event_type, c.code AS event_course FROM notification_logs n LEFT JOIN events e ON n.event_id = CAST(e.id AS TEXT) LEFT JOIN courses c ON e.course_id = c.id WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 30;'
        : 'SELECT n.id, n.user_id, n.event_id, n.notification_type, n.sent_at, n.status, e.title AS event_title, e.type AS event_type, c.code AS event_course FROM notification_logs n LEFT JOIN events e ON n.event_id = CAST(e.id AS TEXT) LEFT JOIN courses c ON e.course_id = c.id ORDER BY n.id DESC LIMIT 30;';

      const logs = targetUserId ? db.prepare(query).all(targetUserId) : db.prepare(query).all();

      const slotStmt = db.prepare(`
        SELECT r.day_of_week, r.start_time, c.code
        FROM routine_slots r
        JOIN courses c ON r.course_id = c.id
        WHERE r.id = ?;
      `);

      const eventStmt = db.prepare(`
        SELECT e.title, c.code
        FROM events e
        LEFT JOIN courses c ON e.course_id = c.id
        WHERE e.id = ?;
      `);

      const enrichedLogs = logs.map(l => {
        let label = l.event_title || l.event_id;
        let courseCode = l.event_course || null;

        if (l.event_id.startsWith('ROUTINE_')) {
          const parts = l.event_id.split('_');
          const slotId = parseInt(parts[1], 10);
          const dateStr = parts[2];
          const slot = slotStmt.get(slotId);
          if (slot) {
            courseCode = slot.code;
            label = `${slot.code} Class Routine (${slot.day_of_week} ${slot.start_time}) on ${dateStr}`;
          } else {
            label = `Class Routine Slot #${slotId} on ${dateStr}`;
          }
        } else if (l.event_id.startsWith('TEST_PING_')) {
          label = '⚡ Discord Connectivity Test Ping';
        } else if (l.event_id.startsWith('MANUAL_TEST_')) {
          const parts = l.event_id.split('_');
          const targetEventId = parseInt(parts[2], 10);
          const orig = eventStmt.get(targetEventId);
          if (orig) {
            courseCode = orig.code;
            label = `Manual Test Alert: ${orig.title}`;
          } else {
            label = `Manual Test Alert for Event #${targetEventId}`;
          }
        }

        return {
          id: l.id,
          userId: l.user_id,
          eventId: l.event_id,
          notificationType: l.notification_type,
          sentAt: l.sent_at,
          status: l.status,
          label,
          courseCode
        };
      });

      res.json({ success: true, data: enrichedLogs });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 16. POST /api/sync - Execute schedule normalization directly on data/schedule_raw.json
  app.post('/api/sync', (req, res) => {
    try {
      const targetUserId = req.body.user_id ? parseInt(req.body.user_id, 10) : getRequestUserId(req, db);
      const rawPath = path.join(ROOT_DIR, 'data', 'schedule_raw.json');
      const result = normalizeAndIngest(rawPath, db, targetUserId);

      const { isoDhaka } = getDhakaContext(new Date());

      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES ('last_synced_at', ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now');
      `).run(isoDhaka);

      db.prepare(`
        INSERT INTO settings (key, value, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(key) DO UPDATE SET
          value = excluded.value,
          updated_at = datetime('now');
      `).run(`last_synced_user_${targetUserId}`, isoDhaka);

      res.json({
        success: true,
        message: 'Schedule synced successfully',
        synced_at: isoDhaka,
        user_id: targetUserId,
        data: result
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 17. GET /api/consultations - Query faculty consultation slots
  app.get('/api/consultations', (req, res) => {
    try {
      const { initial } = req.query;
      let query = 'SELECT * FROM faculty_consultations';
      const params = [];

      if (initial && String(initial).trim()) {
        const cleanInitial = String(initial).trim();
        query += ` WHERE faculty_initial = ? COLLATE NOCASE
                     OR faculty_name LIKE ?
                     OR faculty_initial LIKE ?`;
        params.push(cleanInitial, `%${cleanInitial}%`, `%${cleanInitial}%`);
      }

      query += ` ORDER BY faculty_initial ASC,
        CASE day_of_week
          WHEN 'SUNDAY' THEN 1
          WHEN 'MONDAY' THEN 2
          WHEN 'TUESDAY' THEN 3
          WHEN 'WEDNESDAY' THEN 4
          WHEN 'THURSDAY' THEN 5
          WHEN 'FRIDAY' THEN 6
          WHEN 'SATURDAY' THEN 7
          ELSE 8
        END,
        start_time ASC;`;

      const slots = db.prepare(query).all(...params);
      res.json({ success: true, count: slots.length, data: slots });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 18. POST /api/consultations - Add or update faculty consultation slots
  app.post('/api/consultations', (req, res) => {
    try {
      const payload = req.body;
      const rawSlots = Array.isArray(payload)
        ? payload
        : (Array.isArray(payload?.slots) ? payload.slots : [payload]);

      if (!rawSlots || rawSlots.length === 0 || !rawSlots[0].faculty_initial) {
        return res.status(400).json({
          success: false,
          error: 'Faculty initial, day of week, start time, and end time are required.'
        });
      }

      const results = [];
      const insertOrUpdate = (slot) => {
        const {
          faculty_initial,
          faculty_name,
          day_of_week,
          start_time,
          end_time,
          room,
          contact_email,
          consultation_link
        } = slot;

        if (!faculty_initial || !String(faculty_initial).trim()) {
          throw new Error('Faculty initial is required.');
        }
        if (!day_of_week || !String(day_of_week).trim()) {
          throw new Error('Day of week is required.');
        }
        if (!start_time || !String(start_time).trim()) {
          throw new Error('Start time is required.');
        }
        if (!end_time || !String(end_time).trim()) {
          throw new Error('End time is required.');
        }

        const cleanInitial = String(faculty_initial).trim().toUpperCase();
        const cleanName = faculty_name ? String(faculty_name).trim() : null;
        const cleanDay = String(day_of_week).trim().toUpperCase();
        const cleanStart = normalizeTimeTo24h(start_time);
        const cleanEnd = normalizeTimeTo24h(end_time);
        const cleanRoom = room ? String(room).trim() : null;
        const cleanEmail = contact_email ? String(contact_email).trim() : null;
        const cleanLink = consultation_link ? String(consultation_link).trim() : null;

        const existing = db.prepare(`
          SELECT id FROM faculty_consultations
          WHERE faculty_initial = ? COLLATE NOCASE AND day_of_week = ? COLLATE NOCASE AND start_time = ?
        `).get(cleanInitial, cleanDay, cleanStart);

        if (existing) {
          db.prepare(`
            UPDATE faculty_consultations SET
              faculty_name = COALESCE(?, faculty_name),
              end_time = ?,
              room = ?,
              contact_email = ?,
              consultation_link = ?
            WHERE id = ?;
          `).run(cleanName, cleanEnd, cleanRoom, cleanEmail, cleanLink, existing.id);

          return db.prepare('SELECT * FROM faculty_consultations WHERE id = ?').get(existing.id);
        } else {
          const insertStmt = db.prepare(`
            INSERT INTO faculty_consultations (
              faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            RETURNING *;
          `);
          return insertStmt.get(cleanInitial, cleanName, cleanDay, cleanStart, cleanEnd, cleanRoom, cleanEmail, cleanLink);
        }
      };

      for (const slot of rawSlots) {
        results.push(insertOrUpdate(slot));
      }

      res.json({
        success: true,
        message: `Successfully saved ${results.length} consultation slot(s).`,
        data: results.length === 1 ? results[0] : results
      });
    } catch (err) {
      res.status(400).json({ success: false, error: err.message });
    }
  });

  // 18b. POST /api/consultations/bulk - Parse multiline inputs or array payloads in a single SQLite transaction
  app.post('/api/consultations/bulk', (req, res) => {
    try {
      const payload = req.body;
      let rawSlots = [];

      if (typeof payload === 'string') {
        rawSlots = parseBulkConsultationsText(payload);
      } else if (typeof payload?.text === 'string') {
        rawSlots = parseBulkConsultationsText(payload.text);
      } else if (Array.isArray(payload)) {
        rawSlots = payload;
      } else if (Array.isArray(payload?.slots)) {
        rawSlots = payload.slots;
      }

      if (!rawSlots || rawSlots.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid consultation slots found in payload. Provide a text block or slots array.'
        });
      }

      const performBulkTransaction = db.transaction(() => {
        const results = [];
        for (const slot of rawSlots) {
          const {
            faculty_initial,
            faculty_name,
            day_of_week,
            start_time,
            end_time,
            room,
            contact_email,
            consultation_link
          } = slot;

          if (!faculty_initial || !String(faculty_initial).trim()) continue;
          if (!day_of_week || !String(day_of_week).trim()) continue;
          if (!start_time || !String(start_time).trim()) continue;
          if (!end_time || !String(end_time).trim()) continue;

          const cleanInitial = String(faculty_initial).trim().toUpperCase();
          const cleanName = faculty_name ? String(faculty_name).trim() : null;
          const cleanDay = String(day_of_week).trim().toUpperCase();
          const cleanStart = normalizeTimeTo24h(start_time);
          const cleanEnd = normalizeTimeTo24h(end_time);
          const cleanRoom = room ? String(room).trim() : null;
          const cleanEmail = contact_email ? String(contact_email).trim() : null;
          const cleanLink = consultation_link ? String(consultation_link).trim() : null;

          const existing = db.prepare(`
            SELECT id FROM faculty_consultations
            WHERE faculty_initial = ? COLLATE NOCASE AND day_of_week = ? COLLATE NOCASE AND start_time = ?
          `).get(cleanInitial, cleanDay, cleanStart);

          if (existing) {
            db.prepare(`
              UPDATE faculty_consultations SET
                faculty_name = COALESCE(?, faculty_name),
                end_time = ?,
                room = COALESCE(?, room),
                contact_email = COALESCE(?, contact_email),
                consultation_link = COALESCE(?, consultation_link)
              WHERE id = ?;
            `).run(cleanName, cleanEnd, cleanRoom, cleanEmail, cleanLink, existing.id);

            results.push(db.prepare('SELECT * FROM faculty_consultations WHERE id = ?').get(existing.id));
          } else {
            const insertStmt = db.prepare(`
              INSERT INTO faculty_consultations (
                faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              RETURNING *;
            `);
            results.push(insertStmt.get(cleanInitial, cleanName, cleanDay, cleanStart, cleanEnd, cleanRoom, cleanEmail, cleanLink));
          }
        }
        return results;
      });

      const results = performBulkTransaction();

      if (results.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'No valid consultation slots could be parsed from input.'
        });
      }

      res.json({
        success: true,
        count: results.length,
        message: `Successfully saved ${results.length} consultation slot(s).`,
        data: results
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 19. PUT /api/consultations/:id - Update an existing consultation slot
  app.put('/api/consultations/:id', (req, res) => {
    try {
      const slotId = parseInt(req.params.id, 10);
      if (!slotId || isNaN(slotId)) {
        return res.status(400).json({ success: false, error: 'Invalid consultation ID.' });
      }

      const existing = db.prepare('SELECT * FROM faculty_consultations WHERE id = ?').get(slotId);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Consultation slot not found.' });
      }

      const {
        faculty_initial,
        faculty_name,
        day_of_week,
        start_time,
        end_time,
        room,
        contact_email,
        consultation_link
      } = req.body;

      if (!faculty_initial || !String(faculty_initial).trim()) {
        return res.status(400).json({ success: false, error: 'Faculty initial is required.' });
      }
      if (!day_of_week || !String(day_of_week).trim()) {
        return res.status(400).json({ success: false, error: 'Day of week is required.' });
      }
      if (!start_time || !String(start_time).trim()) {
        return res.status(400).json({ success: false, error: 'Start time is required.' });
      }
      if (!end_time || !String(end_time).trim()) {
        return res.status(400).json({ success: false, error: 'End time is required.' });
      }

      const cleanInitial = String(faculty_initial).trim().toUpperCase();
      const cleanName = faculty_name !== undefined ? (faculty_name ? String(faculty_name).trim() : null) : existing.faculty_name;
      const cleanDay = String(day_of_week).trim().toUpperCase();
      if (!DAYS_OF_WEEK.includes(cleanDay)) {
        return res.status(400).json({ success: false, error: `Invalid day of week "${day_of_week}". Must be SUNDAY through SATURDAY.` });
      }

      const cleanStart = normalizeTimeTo24h(start_time);
      const cleanEnd = normalizeTimeTo24h(end_time);
      const cleanRoom = room !== undefined ? (room ? String(room).trim() : null) : existing.room;
      const cleanEmail = contact_email !== undefined ? (contact_email ? String(contact_email).trim() : null) : existing.contact_email;
      const cleanLink = consultation_link !== undefined ? (consultation_link ? String(consultation_link).trim() : null) : existing.consultation_link;

      db.prepare(`
        UPDATE faculty_consultations SET
          faculty_initial = ?,
          faculty_name = ?,
          day_of_week = ?,
          start_time = ?,
          end_time = ?,
          room = ?,
          contact_email = ?,
          consultation_link = ?
        WHERE id = ?;
      `).run(cleanInitial, cleanName, cleanDay, cleanStart, cleanEnd, cleanRoom, cleanEmail, cleanLink, slotId);

      const updated = db.prepare('SELECT * FROM faculty_consultations WHERE id = ?').get(slotId);
      res.json({
        success: true,
        message: 'Consultation slot updated successfully.',
        data: updated
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 20. DELETE /api/consultations/:id - Remove a consultation slot
  app.delete('/api/consultations/:id', (req, res) => {
    try {
      const slotId = parseInt(req.params.id, 10);
      if (!slotId) {
        return res.status(400).json({ success: false, error: 'Invalid consultation ID.' });
      }

      const existing = db.prepare('SELECT id, faculty_initial FROM faculty_consultations WHERE id = ?').get(slotId);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Consultation slot not found.' });
      }

      db.prepare('DELETE FROM faculty_consultations WHERE id = ?').run(slotId);
      res.json({ success: true, message: 'Consultation slot deleted successfully.' });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // Fallback for SPA routing (redirects unauthenticated users to /login)
  app.use((req, res) => {
    if (req.path === '/login' || req.path === '/login.html') {
      return res.sendFile(path.join(PUBLIC_DIR, 'login.html'));
    }
    const user = req.authenticatedUser || getSessionUser(req, db);
    if (!user) {
      return res.redirect('/login');
    }
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

let activeHttpServer = null;
let shutdownListenersRegistered = false;
let isShuttingDown = false;

/**
 * Stops both the Express HTTP listener and Discord bot client cleanly
 */
export async function stopServer(server = activeHttpServer) {
  if (server) {
    if (server.listening) {
      await new Promise((resolve) => {
        server.close((err) => {
          if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
            console.warn('[!] Error closing HTTP listener:', err.message);
          } else {
            console.log('[-] HTTP listener closed.');
          }
          resolve();
        });
      });
    } else {
      try {
        server.close(() => {});
      } catch {}
    }
    if (server === activeHttpServer) {
      activeHttpServer = null;
    }
  }

  try {
    await stopBot();
    console.log('[-] Discord client and reminder loop stopped cleanly.');
  } catch (err) {
    console.warn('[!] Error stopping bot during server shutdown:', err.message);
  }
}

/**
 * Handles OS signal graceful termination (SIGINT, SIGTERM)
 */
export async function shutdownGracefully(signal = 'SIGTERM') {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n[*] Received ${signal}. Initiating graceful shutdown...`);
  await stopServer();
  console.log('[+] Graceful shutdown complete.');
  process.exit(0);
}

/**
 * Attaches SIGINT and SIGTERM handlers to cleanly terminate Express and the Discord bot
 */
function setupGracefulShutdown(server) {
  activeHttpServer = server;

  if (!shutdownListenersRegistered) {
    shutdownListenersRegistered = true;
    process.once('SIGINT', () => shutdownGracefully('SIGINT'));
    process.once('SIGTERM', () => shutdownGracefully('SIGTERM'));

    process.on('unhandledRejection', (reason) => {
      console.error('[!] Process unhandled promise rejection guarded:', reason?.message || reason);
    });
  }
}

export function startServer(port = process.env.PORT || 3000, host = process.env.HOST || '0.0.0.0') {
  // Initialize Discord bot and reminder loop in the same process
  // Guarded against duplicate bot logins in initBot()
  initBot().catch((err) => {
    console.error('[!] Discord bot initialization warning:', err.message);
  });

  const app = createServer();
  const targetPort = Number(port);
  const targetHost = String(host).trim();

  const server = app.listen(targetPort, targetHost, () => {
    console.log('====================================================');
    console.log(`  FRIDAY ACADEMIC ASSISTANT — UNIFIED WEB + BOT RUNNING`);
    console.log(`  Dashboard URL: ${DASHBOARD_URL}`);
    console.log(`  Bound to Network: ${targetHost}:${targetPort}`);
    console.log('====================================================');
  });

  setupGracefulShutdown(server);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      const nextPort = targetPort + 1;
      console.warn(`[!] Port ${targetPort} is in use, attempting port ${nextPort}...`);
      startServer(nextPort, targetHost);
    } else {
      console.error('[!] Web server failed to start:', err.message);
    }
  });

  return server;
}

// Direct execution or PM2 process
const isDirectExecution =
  process.env.pm_id !== undefined ||
  (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) ||
  (process.argv[1] && path.resolve(process.argv[1] + '.js').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());

if (isDirectExecution) {
  startServer();
}
