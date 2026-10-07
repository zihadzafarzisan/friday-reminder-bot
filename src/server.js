import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import 'dotenv/config';
import { getDb } from './db/index.js';
import { getStoredDiscordUserId, getDhakaContext } from './reminder-engine.js';
import { normalizeAndIngest, normalizeAndIngestPayload } from './normalize.js';
import { getDiscordClient, sendDM, buildTestEmbed, buildExamAlertEmbed, buildTaskAlertEmbed } from './bot.js';
import { buildTaskActionRow } from './commands/handlers.js';
import { EmbedBuilder } from 'discord.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

/**
 * Extracts the targeted user_id from query parameters or headers, defaulting to User #1
 */
function getRequestUserId(req, db) {
  if (req.query.user_id) {
    const parsed = parseInt(req.query.user_id, 10);
    if (!isNaN(parsed)) return parsed;
  }
  if (req.headers['x-user-id']) {
    const parsed = parseInt(req.headers['x-user-id'], 10);
    if (!isNaN(parsed)) return parsed;
  }
  return 1;
}

export function createServer() {
  const app = express();
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
  app.use(express.static(PUBLIC_DIR));

  // 1. GET /api/users - List all registered student profiles
  app.get('/api/users', (req, res) => {
    try {
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
      const targetUserId = req.body.user_id ? parseInt(req.body.user_id, 10) : getRequestUserId(req, db);
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

      const existing = db.prepare('SELECT id, is_custom, title, user_id FROM events WHERE id = ?').get(eventId);
      if (!existing) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }

      if (!existing.is_custom) {
        return res.status(403).json({ success: false, error: 'Cannot edit official university exam schedule.' });
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

      const event = db.prepare('SELECT id, is_custom, title FROM events WHERE id = ?').get(eventId);
      if (!event) {
        return res.status(404).json({ success: false, error: 'Event not found.' });
      }

      if (!event.is_custom) {
        return res.status(403).json({ success: false, error: 'Cannot delete system-synced university exam events.' });
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
          const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN);
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
      const targetUserId = user_id ? parseInt(user_id, 10) : getRequestUserId(req, db);

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

      const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN);
      const embed = buildTestEmbed(client.user?.tag || 'FRIDAY');
      const sendResult = await sendDM(targetDiscordId, { embeds: [embed] }, client);

      const testKey = `TEST_PING_${Date.now()}`;
      const status = sendResult.success ? 'SENT' : 'FAILED';
      db.prepare(`
        INSERT INTO notification_logs (user_id, event_id, notification_type, status)
        VALUES (?, ?, 'TEST_ALERT', ?)
      `).run(targetUserId, testKey, status);

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

      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ev.user_id);
      const targetDiscordId = user?.discord_user_id || getStoredDiscordUserId(db);

      if (!targetDiscordId) {
        return res.status(400).json({ success: false, error: 'No Discord User ID configured for this event.' });
      }
      if (!process.env.DISCORD_BOT_TOKEN) {
        return res.status(400).json({ success: false, error: 'DISCORD_BOT_TOKEN is not configured in .env.' });
      }

      const client = await getDiscordClient(process.env.DISCORD_BOT_TOKEN);
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

      db.prepare(`
        INSERT INTO notification_logs (user_id, event_id, notification_type, status)
        VALUES (?, ?, 'TEST_ALERT', ?)
      `).run(ev.user_id, testKey, status);

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
      const targetUserId = req.query.user_id ? parseInt(req.query.user_id, 10) : null;
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
        query += ' WHERE faculty_initial = ? COLLATE NOCASE';
        params.push(String(initial).trim());
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
        const cleanStart = String(start_time).trim();
        const cleanEnd = String(end_time).trim();
        const cleanRoom = room ? String(room).trim() : null;
        const cleanEmail = contact_email ? String(contact_email).trim() : null;
        const cleanLink = consultation_link ? String(consultation_link).trim() : null;

        const existing = db.prepare(`
          SELECT id FROM faculty_consultations
          WHERE faculty_initial = ? COLLATE NOCASE AND day_of_week = ? AND start_time = ?
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

  // 19. DELETE /api/consultations/:id - Remove a consultation slot
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

  // Fallback to index.html for SPA routing
  app.use((req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });

  return app;
}

export function startServer(port = process.env.PORT || 3000, host = process.env.HOST || '0.0.0.0') {
  const app = createServer();
  const targetPort = Number(port);
  const targetHost = String(host).trim();

  const server = app.listen(targetPort, targetHost, () => {
    console.log('====================================================');
    console.log(`  BRACU CONNECT — WEB CONTROL PANEL RUNNING`);
    console.log(`  Dashboard URL: http://${targetHost === '0.0.0.0' ? 'localhost' : targetHost}:${targetPort}`);
    console.log(`  Bound to Network: ${targetHost}:${targetPort}`);
    console.log('====================================================');
  });

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
  (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) ||
  (process.argv[1] && process.argv[1].endsWith('server.js'));

if (isDirectExecution) {
  startServer();
}
