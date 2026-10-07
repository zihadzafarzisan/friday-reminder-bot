import { getDb } from './db/index.js';
import { sendDM, buildClassAlertEmbed, buildExamAlertEmbed, buildTaskAlertEmbed } from './bot.js';
import { buildTaskActionRow } from './commands/handlers.js';

let isEngineRunning = false;
let engineTimer = null;

export function isReminderEngineRunning() {
  return isEngineRunning;
}

export function startReminderEngine({
  db = getDb(),
  discordClient = null,
  intervalMinutes = parseInt(process.env.REMINDER_INTERVAL_MINUTES || '1', 10)
} = {}) {
  if (isEngineRunning) {
    console.warn('[!] Reminder engine already active. Skipping duplicate initialization.');
    return engineTimer;
  }
  isEngineRunning = true;

  const intervalMs = Math.max(1, intervalMinutes) * 60 * 1000;

  // Run immediate first evaluation tick
  runEvaluationTick({ db, discordClient }).then(dispatches => {
    if (dispatches && dispatches.length > 0) {
      console.log(`[+] Startup tick: Dispatched ${dispatches.length} reminder(s).`);
    } else {
      const now = getDhakaContext();
      console.log(`[+] Startup tick (${now.isoDhaka}): No pending reminders due right now.`);
    }
  }).catch(err => {
    console.error('[!] Error during startup evaluation tick:', err.message);
  });

  // Start periodic evaluation loop
  engineTimer = setInterval(async () => {
    try {
      const dispatches = await runEvaluationTick({ db, discordClient });
      if (dispatches && dispatches.length > 0) {
        for (const d of dispatches) {
          console.log(`[+] Dispatched [${d.type}] ${d.offset} for user ${d.userId} (${d.course}) - Status: ${d.status}`);
        }
      }
    } catch (err) {
      console.error('[!] Error during evaluation tick:', err.message);
    }
  }, intervalMs);

  return engineTimer;
}

export function stopReminderEngine() {
  if (engineTimer) {
    clearInterval(engineTimer);
    engineTimer = null;
  }
  isEngineRunning = false;
}

/**
 * Returns the current date and time components in the Asia/Dhaka (UTC+6) timezone
 */
export function getDhakaContext(referenceDate = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Dhaka',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'long',
    hour12: false
  });

  const parts = formatter.formatToParts(referenceDate);
  const map = {};
  for (const p of parts) map[p.type] = p.value;

  const hour = map.hour === '24' ? '00' : map.hour;
  const dateStr = `${map.year}-${map.month}-${map.day}`;
  const timeStr = `${hour}:${map.minute}:${map.second}`;
  const dayOfWeek = map.weekday.toUpperCase();

  return {
    dateStr,
    timeStr,
    dayOfWeek,
    nowMs: referenceDate.getTime(),
    isoDhaka: `${dateStr}T${timeStr}+06:00`
  };
}

/**
 * Retrieves the configured Discord User ID from the settings table,
 * falling back to process.env.DISCORD_USER_ID.
 */
export function getStoredDiscordUserId(db = getDb()) {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'discord_user_id'").get();
    if (row && row.value && row.value.trim()) {
      return row.value.trim();
    }
  } catch (err) {
    // If settings table not accessible, fallback
  }
  return process.env.DISCORD_USER_ID || null;
}

/**
 * Runs evaluation tick over routine slots, exam events, and custom deadlines for all active users
 */
export async function runEvaluationTick({
  db = getDb(),
  userId = null,
  discordClient = null,
  referenceDate = new Date(),
  dryRun = false
} = {}) {
  const { dateStr, dayOfWeek, nowMs } = getDhakaContext(referenceDate);
  const dispatched = [];

  // Determine target users (multi-tenant)
  let targetUsers = [];
  if (userId) {
    const byUser = db.prepare('SELECT id, discord_user_id FROM users WHERE id = ? OR discord_user_id = ?').get(userId, String(userId));
    if (byUser) {
      targetUsers.push(byUser);
    } else {
      targetUsers.push({ id: 1, discord_user_id: String(userId) });
    }
  } else {
    try {
      targetUsers = db.prepare('SELECT id, discord_user_id FROM users').all();
    } catch {
      targetUsers = [];
    }
    if (targetUsers.length === 0) {
      const fallbackId = getStoredDiscordUserId(db);
      if (fallbackId) {
        targetUsers.push({ id: 1, discord_user_id: fallbackId });
      }
    }
  }

  const checkLogStmt = db.prepare(`
    SELECT status FROM notification_logs 
    WHERE user_id = ? AND entity_id = ? AND entity_type = ? AND alert_window = ? AND notification_date = ?;
  `);

  const recordLogStmt = db.prepare(`
    INSERT INTO notification_logs (
      user_id, entity_id, entity_type, alert_window, notification_date, status, event_id, notification_type
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id, entity_id, entity_type, alert_window, notification_date) DO UPDATE SET
      sent_at = datetime('now'),
      status = excluded.status;
  `);

  const routineSlotsStmt = db.prepare(`
    SELECT 
      r.id AS slot_id,
      r.day_of_week,
      r.start_time,
      r.end_time,
      r.room AS slot_room,
      c.id AS course_id,
      c.code,
      c.name,
      c.section,
      c.faculty,
      c.room AS course_room
    FROM routine_slots r
    JOIN courses c ON r.course_id = c.id
    WHERE r.user_id = ? AND r.day_of_week = ?
    ORDER BY r.start_time ASC;
  `);

  const eventsStmt = db.prepare(`
    SELECT 
      e.id AS event_id,
      e.type,
      e.title,
      e.start_time,
      e.end_time,
      e.room AS event_room,
      e.is_custom,
      c.code,
      c.name,
      c.section,
      c.faculty,
      c.room AS course_room
    FROM events e
    LEFT JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ?
    ORDER BY e.start_time ASC;
  `);

  for (const user of targetUsers) {
    const currentUserId = user.id;
    const targetDiscordUserId = user.discord_user_id;

    // ==========================================
    // 1. RECURRING CLASS SLOTS EVALUATION
    // ==========================================
    const todaySlots = routineSlotsStmt.all(currentUserId, dayOfWeek);

    for (const slot of todaySlots) {
      const slotStartEpoch = new Date(`${dateStr}T${slot.start_time}+06:00`).getTime();
      const diffMinutes = Math.round((slotStartEpoch - nowMs) / 60000);
      const eventKey = `ROUTINE_${slot.slot_id}_${dateStr}`;
      const course = {
        code: slot.code,
        name: slot.name,
        section: slot.section,
        faculty: slot.faculty
      };
      const slotData = {
        start_time: slot.start_time,
        end_time: slot.end_time,
        room: slot.slot_room || slot.course_room || 'TBA'
      };

      // Trigger: 30 minutes before (window: 25 - 30 minutes)
      if (diffMinutes >= 25 && diffMinutes <= 30) {
        const existing = checkLogStmt.get(currentUserId, slot.slot_id, 'routine_slot', '30m', dateStr);
        if (!existing) {
          let status = 'SENT';
          if (!dryRun && targetDiscordUserId && discordClient) {
            const embed = buildClassAlertEmbed(course, slotData, '30M_BEFORE', diffMinutes);
            const res = await sendDM(targetDiscordUserId, { embeds: [embed] }, discordClient);
            status = res.success ? 'SENT' : 'FAILED';
          }
          if (!dryRun) recordLogStmt.run(currentUserId, slot.slot_id, 'routine_slot', '30m', dateStr, status, eventKey, '30M_BEFORE');
          dispatched.push({ userId: currentUserId, targetDiscordUserId, type: 'ROUTINE', eventKey, offset: '30M_BEFORE', diffMinutes, course: slot.code, status });
        }
      }

      // Trigger: 10 minutes before (window: 5 - 10 minutes)
      if (diffMinutes >= 5 && diffMinutes <= 10) {
        const existing = checkLogStmt.get(currentUserId, slot.slot_id, 'routine_slot', '10m', dateStr);
        if (!existing) {
          let status = 'SENT';
          if (!dryRun && targetDiscordUserId && discordClient) {
            const embed = buildClassAlertEmbed(course, slotData, '10M_BEFORE', diffMinutes);
            const res = await sendDM(targetDiscordUserId, { embeds: [embed] }, discordClient);
            status = res.success ? 'SENT' : 'FAILED';
          }
          if (!dryRun) recordLogStmt.run(currentUserId, slot.slot_id, 'routine_slot', '10m', dateStr, status, eventKey, '10M_BEFORE');
          dispatched.push({ userId: currentUserId, targetDiscordUserId, type: 'ROUTINE', eventKey, offset: '10M_BEFORE', diffMinutes, course: slot.code, status });
        }
      }
    }

    // ==========================================
    // 2. DISCRETE EVENTS EVALUATION (Exams & Custom Tasks)
    // ==========================================
    const allEvents = eventsStmt.all(currentUserId);

    for (const ev of allEvents) {
      const eventStartEpoch = new Date(ev.start_time).getTime();
      const diffMinutes = Math.round((eventStartEpoch - nowMs) / 60000);
      const eventKey = String(ev.event_id);
      const isExam = ev.type === 'MIDTERM' || ev.type === 'FINAL';

      const course = ev.code ? {
        code: ev.code,
        name: ev.name,
        section: ev.section,
        faculty: ev.faculty
      } : null;

      const eventData = {
        type: ev.type,
        title: ev.title,
        start_time: ev.start_time,
        end_time: ev.end_time,
        room: ev.event_room || ev.course_room || 'TBA'
      };

      const getEmbed = (offset, countdownText) => {
        if (isExam && course) {
          return buildExamAlertEmbed(course, eventData, offset, countdownText);
        }
        return buildTaskAlertEmbed(course, eventData, offset, countdownText);
      };

      const components = ev.is_custom ? [buildTaskActionRow(ev.event_id)] : [];

      // Trigger: 24 hours before (window: 1410 - 1440 minutes)
      if (diffMinutes >= 1410 && diffMinutes <= 1440) {
        const existing = checkLogStmt.get(currentUserId, ev.event_id, 'event', '24h', dateStr);
        if (!existing) {
          let status = 'SENT';
          if (!dryRun && targetDiscordUserId && discordClient) {
            const embed = getEmbed('24H_BEFORE', '24 hours');
            const res = await sendDM(targetDiscordUserId, { embeds: [embed], components }, discordClient);
            status = res.success ? 'SENT' : 'FAILED';
          }
          if (!dryRun) recordLogStmt.run(currentUserId, ev.event_id, 'event', '24h', dateStr, status, eventKey, '24H_BEFORE');
          dispatched.push({ userId: currentUserId, targetDiscordUserId, type: ev.type, eventKey, offset: '24H_BEFORE', diffMinutes, course: ev.code || ev.title, status });
        }
      }

      // Trigger: 1 hour before (window: 50 - 60 minutes)
      if (diffMinutes >= 50 && diffMinutes <= 60) {
        const existing = checkLogStmt.get(currentUserId, ev.event_id, 'event', '1h', dateStr);
        if (!existing) {
          let status = 'SENT';
          if (!dryRun && targetDiscordUserId && discordClient) {
            const embed = getEmbed('1H_BEFORE', '1 hour');
            const res = await sendDM(targetDiscordUserId, { embeds: [embed], components }, discordClient);
            status = res.success ? 'SENT' : 'FAILED';
          }
          if (!dryRun) recordLogStmt.run(currentUserId, ev.event_id, 'event', '1h', dateStr, status, eventKey, '1H_BEFORE');
          dispatched.push({ userId: currentUserId, targetDiscordUserId, type: ev.type, eventKey, offset: '1H_BEFORE', diffMinutes, course: ev.code || ev.title, status });
        }
      }

      // Trigger: 10 minutes before (window: 5 - 10 minutes) for quizzes, assignments, and tasks
      if (!isExam && diffMinutes >= 5 && diffMinutes <= 10) {
        const existing = checkLogStmt.get(currentUserId, ev.event_id, 'event', '10m', dateStr);
        if (!existing) {
          let status = 'SENT';
          if (!dryRun && targetDiscordUserId && discordClient) {
            const embed = getEmbed('10M_BEFORE', `${diffMinutes} minutes`);
            const res = await sendDM(targetDiscordUserId, { embeds: [embed], components }, discordClient);
            status = res.success ? 'SENT' : 'FAILED';
          }
          if (!dryRun) recordLogStmt.run(currentUserId, ev.event_id, 'event', '10m', dateStr, status, eventKey, '10M_BEFORE');
          dispatched.push({ userId: currentUserId, targetDiscordUserId, type: ev.type, eventKey, offset: '10M_BEFORE', diffMinutes, course: ev.code || ev.title, status });
        }
      }
    }
  }

  return dispatched;
}
