import { 
  EmbedBuilder, 
  ModalBuilder, 
  TextInputBuilder, 
  TextInputStyle, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
import crypto from 'crypto';
import { getDb } from '../db/index.js';
import { getDhakaContext } from '../reminder-engine.js';
import { normalizeAndIngestPayload } from '../normalize.js';

export const DASHBOARD_URL = process.env.DASHBOARD_URL || 'https://friday.alwaysdata.net';

/**
 * Generates a clean 6-character uppercase hex pairing code (e.g. BRC-E4B29A)
 */
export function generatePairingCode() {
  return 'BRC-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/**
 * Resolves the database user row corresponding to a Discord interaction user
 */
export function getUserFromInteraction(interaction, db = getDb()) {
  const discordId = interaction.user?.id;
  if (discordId) {
    const user = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(discordId);
    if (user) return user;
  }
  // Fallback to default user if interaction has no user object (e.g. unit tests)
  if (!interaction.user) {
    return db.prepare('SELECT * FROM users WHERE id = 1').get() || null;
  }
  return null;
}

/**
 * Main interaction router for Discord application slash commands, modals, and buttons
 */
export async function handleInteraction(interaction, db = getDb()) {
  try {
    if (interaction.isChatInputCommand && interaction.isChatInputCommand()) {
      const { commandName } = interaction;
      if (commandName === 'start' || commandName === 'link') {
        await handleStartCommand(interaction, db);
      } else if (commandName === 'today') {
        await handleTodayCommand(interaction, db);
      } else if (commandName === 'next') {
        await handleNextCommand(interaction, db);
      } else if (commandName === 'deadlines') {
        await handleDeadlinesCommand(interaction, db);
      } else if (commandName === 'addtask') {
        await handleAddtaskCommand(interaction);
      } else if (commandName === 'consultation') {
        await handleConsultationCommand(interaction);
      } else if (commandName === 'import') {
        await handleImportCommand(interaction, db);
      } else if (commandName === 'routine') {
        await handleRoutineCommand(interaction, db);
      } else if (commandName === 'reset') {
        await handleResetCommand(interaction, db);
      } else {
        await interaction.reply({ content: `Unknown command: /${commandName}`, ephemeral: true });
      }
    } else if (interaction.isModalSubmit && interaction.isModalSubmit()) {
      if (interaction.customId === 'modal_add_task') {
        await handleTaskModalSubmit(interaction, db);
      } else if (interaction.customId === 'faculty_consultation_modal') {
        await handleConsultationModalSubmit(interaction, db);
      }
    } else if (interaction.isStringSelectMenu ? interaction.isStringSelectMenu() : (interaction.isAnySelectMenu && interaction.isAnySelectMenu())) {
      if (interaction.customId === 'routine_day_select') {
        await handleRoutineSelectMenu(interaction, db);
      }
    } else if (interaction.isButton && interaction.isButton()) {
      if (interaction.customId === 'confirm_routine_reset') {
        await handleConfirmResetButton(interaction, db);
      } else if (interaction.customId.startsWith('complete_task_')) {
        await handleTaskButton(interaction, db);
      }
    }
  } catch (err) {
    console.error('[!] Error executing interaction:', err);
    const errorMsg = '⚠️ An error occurred while processing your request.';
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content: errorMsg, ephemeral: true });
    } else {
      await interaction.reply({ content: errorMsg, ephemeral: true });
    }
  }
}

/**
 * /start or /link: Generate or retrieve user pairing code and onboarding instructions
 */
export async function handleStartCommand(interaction, db = getDb()) {
  const discordUserId = interaction.user.id;
  const username = interaction.user.username || 'Student';

  let user = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(discordUserId);

  if (!user) {
    const pairingCode = generatePairingCode();
    db.prepare(`
      INSERT INTO users (discord_user_id, pairing_code, created_at)
      VALUES (?, ?, datetime('now'))
    `).run(discordUserId, pairingCode);
    user = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(discordUserId);
  } else if (!user.pairing_code) {
    const pairingCode = generatePairingCode();
    db.prepare('UPDATE users SET pairing_code = ? WHERE id = ?').run(pairingCode, user.id);
    user.pairing_code = pairingCode;
  }

  const courseCount = db.prepare('SELECT count(*) as c FROM courses WHERE user_id = ?').get(user.id)?.c || 0;
  const eventCount = db.prepare('SELECT count(*) as c FROM events WHERE user_id = ?').get(user.id)?.c || 0;

  const embed = new EmbedBuilder()
    .setTitle('FRIDAY Academic Assistant')
    .setColor(0x6366F1)
    .setDescription(
      `**Well, well! Look who summoned FRIDAY!**\n\n` +
      `Hello **${username}**! I'm FRIDAY, your daily academic assistant.\n\n` +
      `Your Discord account is linked to FRIDAY.\n` +
      `Use your personal pairing code below to import your class schedule into FRIDAY.`
    )
    .addFields(
      {
        name: '🔑 Your Personal Pairing Code',
        value: `\`\`\`${user.pairing_code}\`\`\``,
        inline: false
      },
      {
        name: '🌐 Dashboard Link',
        value: `[Your Dashboard](${DASHBOARD_URL})`,
        inline: false
      },
      {
        name: '📋 Quick Import Guide',
        value: 
          `1. Open [Your Dashboard](${DASHBOARD_URL}) and navigate to the Import Schedule tab.\n` +
          `2. Paste your Pairing Code: \`${user.pairing_code}\`\n` +
          `3. Upload \`schedule_raw.json\` or use the consultation tools.\n\n` +
          `*Current Status: **${courseCount}** course(s) and **${eventCount}** deadline(s) linked.*`,
        inline: false
      }
    )
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  const linkButton = new ButtonBuilder()
    .setLabel('Your Dashboard')
    .setStyle(ButtonStyle.Link)
    .setURL(DASHBOARD_URL);

  const row = new ActionRowBuilder().addComponents(linkButton);

  return interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
}

/**
 * /today: View today's class schedule, room numbers, and timings (scoped to user)
 */
export async function handleTodayCommand(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ You have not linked your Discord account yet! Run **/start** to get your pairing code and import your BRACU schedule.',
      ephemeral: true
    });
  }

  const { dateStr, dayOfWeek } = getDhakaContext();

  // 1. Query today's routine class slots for this user
  const slots = db.prepare(`
    SELECT 
      r.id,
      r.start_time,
      r.end_time,
      COALESCE(r.room, c.room) AS room,
      c.code,
      c.name,
      c.section,
      c.faculty
    FROM routine_slots r
    JOIN courses c ON r.course_id = c.id
    WHERE r.user_id = ? AND r.day_of_week = ?
    ORDER BY r.start_time ASC;
  `).all(user.id, dayOfWeek);

  // 2. Query today's discrete events for this user
  const events = db.prepare(`
    SELECT 
      e.id,
      e.type,
      e.title,
      e.start_time,
      e.end_time,
      COALESCE(e.room, c.room) AS room,
      c.code,
      c.section
    FROM events e
    LEFT JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ? AND e.start_time LIKE ?
    ORDER BY e.start_time ASC;
  `).all(user.id, `${dateStr}%`);

  const totalCourses = db.prepare('SELECT count(*) as c FROM courses WHERE user_id = ?').get(user.id)?.c || 0;
  if (totalCourses === 0 && events.length === 0) {
    return interaction.reply({
      content: `ℹ️ You haven't imported your schedule yet! Run **/start** or visit ${DASHBOARD_URL}/#import using your code \`${user.pairing_code}\` to upload your courses.`,
      ephemeral: true
    });
  }

  // If no classes and no events today
  if (slots.length === 0 && events.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle(`📅 Today's Schedule — ${dayOfWeek}`)
      .setDescription(`🎉 **No scheduled classes or deadlines today!**\nEnjoy your free day to relax or catch up on coursework.`)
      .setColor(0x10B981) // Emerald Green
      .setFooter({ text: `FRIDAY Academic Assistant • ${dateStr} (Asia/Dhaka)` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  const embed = new EmbedBuilder()
    .setTitle(`📅 Today's Schedule — ${dayOfWeek} (${dateStr})`)
    .setColor(0x6366F1) // Indigo
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  if (slots.length > 0) {
    for (const s of slots) {
      const startClean = s.start_time.substring(0, 5);
      const endClean = s.end_time.substring(0, 5);
      embed.addFields({
        name: `⏰ ${startClean} - ${endClean} BST • ${s.code} (Sec ${s.section})`,
        value: `📍 Room: **${s.room || 'TBA'}** • 👨‍🏫 Faculty: ${s.faculty || 'N/A'}\n*${s.name || 'Enrolled Course'}*`,
        inline: false
      });
    }
  } else {
    embed.addFields({
      name: 'Class Routine',
      value: 'No routine classes scheduled for today.',
      inline: false
    });
  }

  if (events.length > 0) {
    const eventLines = events.map(ev => {
      const timeFmt = new Date(ev.start_time).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Dhaka',
        hour: '2-digit',
        minute: '2-digit',
        hour12: true
      });
      return `• **[${ev.type}]** ${ev.title} at **${timeFmt}** (📍 Room: ${ev.room || 'TBA'})`;
    }).join('\n');

    embed.addFields({
      name: `🚨 Deadlines / Tasks Today (${events.length})`,
      value: eventLines,
      inline: false
    });
  }

  return interaction.reply({ embeds: [embed] });
}

/**
 * /next: Find your next upcoming class or exam with countdown (scoped to user)
 */
export async function handleNextCommand(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ You have not linked your Discord account yet! Run **/start** to get your pairing code and import your BRACU schedule.',
      ephemeral: true
    });
  }

  const now = new Date();
  const nowMs = now.getTime();
  const { dateStr, dayOfWeek } = getDhakaContext(now);

  const candidates = [];

  // 1. Remaining class routine slots for TODAY
  const todaySlots = db.prepare(`
    SELECT 
      r.id,
      r.start_time,
      r.end_time,
      COALESCE(r.room, c.room) AS room,
      c.code,
      c.name,
      c.section,
      c.faculty
    FROM routine_slots r
    JOIN courses c ON r.course_id = c.id
    WHERE r.user_id = ? AND r.day_of_week = ?
    ORDER BY r.start_time ASC;
  `).all(user.id, dayOfWeek);

  for (const s of todaySlots) {
    const epoch = new Date(`${dateStr}T${s.start_time}+06:00`).getTime();
    if (epoch > nowMs) {
      candidates.push({
        epoch,
        kind: 'CLASS',
        title: `${s.code} Class (Sec ${s.section})`,
        courseCode: s.code,
        courseName: s.name,
        room: s.room || 'TBA',
        faculty: s.faculty,
        timeLabel: `${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)} BST`
      });
    }
  }

  // 2. Upcoming discrete events (Midterm, Final, Quiz, Assignment, etc.)
  const allEvents = db.prepare(`
    SELECT 
      e.id,
      e.type,
      e.title,
      e.start_time,
      e.end_time,
      COALESCE(e.room, c.room) AS room,
      c.code,
      c.name,
      c.section,
      c.faculty
    FROM events e
    LEFT JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ?
    ORDER BY e.start_time ASC;
  `).all(user.id);

  for (const ev of allEvents) {
    const epoch = new Date(ev.start_time).getTime();
    if (epoch > nowMs) {
      candidates.push({
        epoch,
        kind: ev.type,
        title: ev.title,
        courseCode: ev.code,
        courseName: ev.name,
        room: ev.room || 'TBA',
        faculty: ev.faculty,
        timeLabel: ev.start_time
      });
    }
  }

  // 3. Routine slots over the upcoming 7 days
  for (let offset = 1; offset <= 7; offset++) {
    const futureDate = new Date(nowMs + offset * 86400000);
    const { dateStr: futureDateStr, dayOfWeek: futureDayOfWeek } = getDhakaContext(futureDate);

    const futureSlots = db.prepare(`
      SELECT 
        r.id,
        r.start_time,
        r.end_time,
        COALESCE(r.room, c.room) AS room,
        c.code,
        c.name,
        c.section,
        c.faculty
      FROM routine_slots r
      JOIN courses c ON r.course_id = c.id
      WHERE r.user_id = ? AND r.day_of_week = ?
      ORDER BY r.start_time ASC;
    `).all(user.id, futureDayOfWeek);

    for (const s of futureSlots) {
      const epoch = new Date(`${futureDateStr}T${s.start_time}+06:00`).getTime();
      if (epoch > nowMs) {
        candidates.push({
          epoch,
          kind: 'CLASS',
          title: `${s.code} Class (Sec ${s.section})`,
          courseCode: s.code,
          courseName: s.name,
          room: s.room || 'TBA',
          faculty: s.faculty,
          timeLabel: `${futureDateStr} (${futureDayOfWeek}) ${s.start_time.substring(0, 5)} BST`
        });
      }
    }
  }

  if (candidates.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle('⏳ Next Academic Event')
      .setDescription('No upcoming classes, exams, or deadlines found on your schedule.')
      .setColor(0x9CA3AF)
      .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  // Sort chronologically and take the closest one
  candidates.sort((a, b) => a.epoch - b.epoch);
  const next = candidates[0];
  const unixSec = Math.floor(next.epoch / 1000);

  // Distinct colors per event type
  let color = 0x3498DB; // Blue for Class
  if (next.kind === 'FINAL') color = 0xE74C3C; // Red
  else if (next.kind === 'MIDTERM') color = 0x9B59B6; // Purple
  else if (next.kind === 'QUIZ') color = 0xF59E0B; // Amber
  else if (next.kind === 'ASSIGNMENT') color = 0x06B6D4; // Cyan

  const embed = new EmbedBuilder()
    .setTitle(`⏳ Next Up: ${next.title}`)
    .setDescription(`Starts in **<t:${unixSec}:R>**`)
    .setColor(color)
    .addFields(
      { name: 'Event Type', value: `🏷️ **${next.kind}**`, inline: true },
      { name: 'Room / Venue', value: `📍 **${next.room || 'TBA'}**`, inline: true }
    );

  if (next.courseCode) {
    embed.addFields({
      name: 'Course & Faculty',
      value: `📘 **${next.courseCode}** ${next.faculty ? `• 👨‍🏫 ${next.faculty}` : ''}`,
      inline: false
    });
  }

  embed.addFields({
    name: 'Scheduled Time',
    value: `🗓️ <t:${unixSec}:F>\n⏰ \`${next.timeLabel}\``,
    inline: false
  });

  embed.setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' }).setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

/**
 * /deadlines: List upcoming quizzes, assignments, midterms, and finals (scoped to user)
 */
export async function handleDeadlinesCommand(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ You have not linked your Discord account yet! Run **/start** to get your pairing code and import your BRACU schedule.',
      ephemeral: true
    });
  }

  const nowMs = Date.now();

  const events = db.prepare(`
    SELECT 
      e.id,
      e.type,
      e.title,
      e.start_time,
      e.end_time,
      COALESCE(e.room, c.room) AS room,
      c.code AS course_code,
      c.name AS course_name,
      c.section AS course_section
    FROM events e
    LEFT JOIN courses c ON e.course_id = c.id
    WHERE e.user_id = ?
    ORDER BY e.start_time ASC;
  `).all(user.id);

  const upcoming = events.filter(e => new Date(e.start_time).getTime() > nowMs);

  if (upcoming.length === 0) {
    const embed = new EmbedBuilder()
      .setTitle('📝 Upcoming Academic Deadlines')
      .setDescription('🎉 **You are all caught up!**\nNo upcoming midterms, finals, quizzes, or assignments found in your schedule.')
      .setColor(0x10B981)
      .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }

  const exams = upcoming.filter(e => e.type === 'MIDTERM' || e.type === 'FINAL');
  const quizzes = upcoming.filter(e => e.type === 'QUIZ' || e.type === 'LAB_TASK');
  const assignments = upcoming.filter(e => e.type === 'ASSIGNMENT' || (e.type !== 'MIDTERM' && e.type !== 'FINAL' && e.type !== 'QUIZ' && e.type !== 'LAB_TASK'));

  const formatList = (items) => {
    return items.map(i => {
      const unix = Math.floor(new Date(i.start_time).getTime() / 1000);
      const courseTag = i.course_code ? `\`${i.course_code}\`` : '';
      return `• **${i.title}** ${courseTag}\n  🗓️ <t:${unix}:F> (<t:${unix}:R>) • 📍 Room: **${i.room || 'TBA'}**`;
    }).join('\n\n');
  };

  const embed = new EmbedBuilder()
    .setTitle(`📝 Upcoming Academic Deadlines (${upcoming.length})`)
    .setDescription('Here is your active schedule of upcoming exams, quizzes, and project deadlines:')
    .setColor(0x6366F1)
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  if (exams.length > 0) {
    embed.addFields({
      name: `🎯 Midterm & Final Exams (${exams.length})`,
      value: formatList(exams),
      inline: false
    });
  }

  if (quizzes.length > 0) {
    embed.addFields({
      name: `📝 Quizzes & Class Tests (${quizzes.length})`,
      value: formatList(quizzes),
      inline: false
    });
  }

  if (assignments.length > 0) {
    embed.addFields({
      name: `📌 Assignments & Tasks (${assignments.length})`,
      value: formatList(assignments),
      inline: false
    });
  }

  return interaction.reply({ embeds: [embed] });
}

/**
 * Builds the native Discord modal for adding an academic task
 */
export function buildAddTaskModal() {
  const modal = new ModalBuilder()
    .setCustomId('modal_add_task')
    .setTitle('Add Academic Deadline / Task');

  const courseInput = new TextInputBuilder()
    .setCustomId('task_course')
    .setLabel('Course Code (e.g. CSE230, HUM101, MAT216)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('CSE230 (or leave empty if general)')
    .setRequired(false);

  const typeInput = new TextInputBuilder()
    .setCustomId('task_type')
    .setLabel('Type (QUIZ | ASSIGNMENT | MAKEUP)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('QUIZ')
    .setValue('QUIZ')
    .setRequired(true);

  const titleInput = new TextInputBuilder()
    .setCustomId('task_title')
    .setLabel('Title / Description')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Quiz 2: Cache Memory')
    .setRequired(true);

  const datetimeInput = new TextInputBuilder()
    .setCustomId('task_datetime')
    .setLabel('Due Date & Time (YYYY-MM-DD HH:mm BST)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('2026-10-06 14:30')
    .setRequired(true);

  const roomInput = new TextInputBuilder()
    .setCustomId('task_room')
    .setLabel('Room / Location (Optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('08H-22C or Online')
    .setRequired(false);

  modal.addComponents(
    new ActionRowBuilder().addComponents(courseInput),
    new ActionRowBuilder().addComponents(typeInput),
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(datetimeInput),
    new ActionRowBuilder().addComponents(roomInput)
  );

  return modal;
}

/**
 * Handles /addtask command by displaying the modal
 */
export async function handleAddtaskCommand(interaction) {
  const modal = buildAddTaskModal();
  await interaction.showModal(modal);
}

/**
 * Parses user datetime input into ISO-8601 with Asia/Dhaka (+06:00) offset
 */
export function parseDhakaInputToIso(inputStr) {
  if (!inputStr) return null;
  const normalized = inputStr.trim().replace(/\//g, '-').replace(' ', 'T');
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;

  const [_, y, m, d, h, min, s] = match;
  const month = m.padStart(2, '0');
  const day = d.padStart(2, '0');
  const hour = h.padStart(2, '0');
  const minute = min.padStart(2, '0');
  const second = (s || '00').padStart(2, '0');

  const iso = `${y}-${month}-${day}T${hour}:${minute}:${second}+06:00`;
  const parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return null;
  return iso;
}

/**
 * Handles modal submission for modal_add_task (scoped to user)
 */
export async function handleTaskModalSubmit(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ You have not linked your Discord account yet! Run **/start** first.',
      ephemeral: true
    });
  }

  const courseCodeInput = interaction.fields.getTextInputValue('task_course');
  const typeInput = interaction.fields.getTextInputValue('task_type');
  const titleInput = interaction.fields.getTextInputValue('task_title');
  const datetimeInput = interaction.fields.getTextInputValue('task_datetime');
  const roomInput = interaction.fields.getTextInputValue('task_room');

  if (!titleInput || !titleInput.trim()) {
    return interaction.reply({ content: '⚠️ Task title is required.', ephemeral: true });
  }

  // Parse datetime as Asia/Dhaka (+06:00)
  const isoDhaka = parseDhakaInputToIso(datetimeInput);
  if (!isoDhaka) {
    return interaction.reply({
      content: '⚠️ Invalid date/time format. Please use **YYYY-MM-DD HH:mm** (e.g. `2026-10-06 14:30`).',
      ephemeral: true
    });
  }

  const epoch = new Date(isoDhaka).getTime();
  if (isNaN(epoch)) {
    return interaction.reply({
      content: '⚠️ Invalid calendar date entered.',
      ephemeral: true
    });
  }

  // Match course code if provided (within this user's enrolled courses)
  let courseId = null;
  let matchedCourse = null;
  if (courseCodeInput && courseCodeInput.trim()) {
    const cleanCode = courseCodeInput.trim().toUpperCase().replace(/\s+/g, '');
    matchedCourse = db.prepare(`
      SELECT id, code, name, section, faculty, room
      FROM courses
      WHERE user_id = ? AND REPLACE(UPPER(code), ' ', '') = ?
      LIMIT 1;
    `).get(user.id, cleanCode);

    if (matchedCourse) {
      courseId = matchedCourse.id;
    }
  }

  const cleanType = (typeInput || 'ASSIGNMENT').trim().toUpperCase();
  const cleanTitle = titleInput.trim();
  const cleanRoom = roomInput?.trim() || matchedCourse?.room || null;

  // Insert into events table with user_id and is_custom = 1
  const insertStmt = db.prepare(`
    INSERT INTO events (user_id, course_id, type, title, start_time, end_time, room, is_custom)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    RETURNING id;
  `);

  const created = insertStmt.get(user.id, courseId, cleanType, cleanTitle, isoDhaka, isoDhaka, cleanRoom);
  const unixSec = Math.floor(epoch / 1000);

  // Build confirmation embed
  const embed = new EmbedBuilder()
    .setTitle(`✅ Task Created: ${cleanTitle}`)
    .setDescription(`Deadline scheduled for **<t:${unixSec}:F>** (<t:${unixSec}:R>)`)
    .setColor(0x10B981)
    .addFields(
      { name: 'Type', value: `🏷️ **${cleanType}**`, inline: true },
      { name: 'Room / Venue', value: `📍 **${cleanRoom || 'TBA'}**`, inline: true },
      { 
        name: 'Course', 
        value: matchedCourse ? `📘 **${matchedCourse.code}** (Sec ${matchedCourse.section})` : 'General / None', 
        inline: false 
      }
    )
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  return interaction.reply({ embeds: [embed] });
}

/**
 * Builds an ActionRow containing the 'Mark Completed' green button
 */
export function buildTaskActionRow(eventId) {
  const completeBtn = new ButtonBuilder()
    .setCustomId(`complete_task_${eventId}`)
    .setLabel('Mark Completed')
    .setStyle(ButtonStyle.Success)
    .setEmoji('✅');

  return new ActionRowBuilder().addComponents(completeBtn);
}

/**
 * Handles 'Mark Completed' button clicks for custom tasks (scoped to user)
 */
export async function handleTaskButton(interaction, db = getDb()) {
  const { customId } = interaction;
  const eventIdStr = customId.replace('complete_task_', '');
  const eventId = parseInt(eventIdStr, 10);
  const user = getUserFromInteraction(interaction, db);
  const userId = user ? user.id : 1;

  // 1. Fetch event from DB
  const ev = db.prepare(`
    SELECT e.*, c.code
    FROM events e
    LEFT JOIN courses c ON e.course_id = c.id
    WHERE e.id = ?;
  `).get(eventId);

  const eventTitle = ev ? ev.title : `Task #${eventId}`;

  // 2. Delete event from academic.db
  if (ev) {
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
  }

  // 3. Record in notification_logs to suppress remaining tiers
  const suppressionTiers = ['COMPLETED', '24H_BEFORE', '1H_BEFORE', '30M_BEFORE', '10M_BEFORE'];
  const logStmt = db.prepare(`
    INSERT INTO notification_logs (user_id, event_id, notification_type, status)
    VALUES (?, ?, ?, 'COMPLETED')
    ON CONFLICT(user_id, event_id, notification_type) DO UPDATE SET
      sent_at = datetime('now'),
      status = 'COMPLETED';
  `);
  for (const tier of suppressionTiers) {
    logStmt.run(userId, String(eventId), tier);
  }

  // 4. Update the original message embed and disable button
  const originalEmbed = interaction.message.embeds[0];
  const updatedEmbed = EmbedBuilder.from(originalEmbed || {})
    .setColor(0x10B981)
    .setFooter({ text: `✅ Marked Completed by ${interaction.user.username} • FRIDAY Academic Assistant` });

  const disabledBtn = new ButtonBuilder()
    .setCustomId(`completed_${eventId}`)
    .setLabel('Marked Completed')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('✅')
    .setDisabled(true);

  const disabledRow = new ActionRowBuilder().addComponents(disabledBtn);

  await interaction.update({
    content: `✅ **${eventTitle}** was marked as completed!`,
    embeds: [updatedEmbed],
    components: [disabledRow]
  });
}

/**
 * Builds the Faculty Consultation Lookup modal
 */
export function buildConsultationModal() {
  const modal = new ModalBuilder()
    .setCustomId('faculty_consultation_modal')
    .setTitle('Faculty Consultation Lookup');

  const initialInput = new TextInputBuilder()
    .setCustomId('faculty_initial')
    .setLabel('Faculty Initial')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('MSI')
    .setRequired(true);

  modal.addComponents(
    new ActionRowBuilder().addComponents(initialInput)
  );

  return modal;
}

/**
 * Handles /consultation command by showing the lookup modal
 */
export async function handleConsultationCommand(interaction) {
  const modal = buildConsultationModal();
  await interaction.showModal(modal);
}

/**
 * Helper to capitalize day of week name (e.g. SUNDAY -> Sunday)
 */
export function formatDayName(day) {
  if (!day) return '';
  const s = String(day).trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Normalizes and formats time to 12-hour AM/PM format (e.g. 14:00 -> 02:00 PM)
 */
export function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const trimmed = String(timeStr).trim();
  const match12 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i);
  if (match12) {
    const hh = match12[1].padStart(2, '0');
    const mm = match12[2];
    const ampm = match12[3].toUpperCase();
    return `${hh}:${mm} ${ampm}`;
  }
  const match24 = trimmed.match(/^(\d{1,2}):(\d{2})(?::\d{2})?$/);
  if (match24) {
    let h = parseInt(match24[1], 10);
    const mm = match24[2];
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const hh = String(h).padStart(2, '0');
    return `${hh}:${mm} ${ampm}`;
  }
  return trimmed;
}

/**
 * Formats room and/or meeting link for consultation display
 */
export function formatLocation(slot) {
  const room = slot.room ? String(slot.room).trim() : '';
  const link = slot.consultation_link ? String(slot.consultation_link).trim() : '';

  if (room && link) {
    const displayLink = link.replace(/^https?:\/\//i, '');
    return `📍 ${room} ([${displayLink}](${link}))`;
  }
  if (room) {
    return `📍 ${room}`;
  }
  if (link) {
    const displayLink = link.replace(/^https?:\/\//i, '');
    return `📍 Online ([${displayLink}](${link}))`;
  }
  return '📍 TBA';
}

/**
 * Handles modal submission for faculty_consultation_modal
 */
export async function handleConsultationModalSubmit(interaction, db = getDb()) {
  let rawInitial = '';
  if (interaction.fields && typeof interaction.fields.getTextInputValue === 'function') {
    rawInitial = interaction.fields.getTextInputValue('faculty_initial');
  } else if (interaction.fields && interaction.fields.faculty_initial) {
    rawInitial = interaction.fields.faculty_initial;
  }

  if (!rawInitial || !rawInitial.trim()) {
    return interaction.reply({
      content: '⚠️ Please provide a faculty initial to look up.',
      ephemeral: true
    });
  }

  const initial = rawInitial.trim().toUpperCase();

  const slots = db.prepare(`
    SELECT * FROM faculty_consultations 
    WHERE faculty_initial = ? COLLATE NOCASE
    ORDER BY 
      CASE UPPER(day_of_week)
        WHEN 'SUNDAY' THEN 1
        WHEN 'MONDAY' THEN 2
        WHEN 'TUESDAY' THEN 3
        WHEN 'WEDNESDAY' THEN 4
        WHEN 'THURSDAY' THEN 5
        WHEN 'FRIDAY' THEN 6
        WHEN 'SATURDAY' THEN 7
        ELSE 8
      END,
      start_time ASC;
  `).all(initial);

  if (slots.length === 0) {
    return interaction.reply({
      content: `❌ No consultation hours found for faculty initial **${initial}**.`,
      ephemeral: true
    });
  }

  const facultyName = slots.find(s => s.faculty_name)?.faculty_name || null;
  const facultyEmail = slots.find(s => s.contact_email)?.contact_email || null;

  const embedTitle = facultyName 
    ? `👨‍🏫 Consultation Hours: ${facultyName} (${initial})`
    : `👨‍🏫 Consultation Hours: ${initial}`;

  const lines = [];
  if (facultyEmail) {
    lines.push(`📧 **Email:** \`${facultyEmail}\`\n`);
  }

  for (const slot of slots) {
    const dayName = formatDayName(slot.day_of_week);
    const dayPad = `${dayName}:`.padEnd(11, ' ');
    const startFmt = formatTime12h(slot.start_time);
    const endFmt = formatTime12h(slot.end_time);
    const loc = formatLocation(slot);

    lines.push(`• ${dayPad} ${startFmt} - ${endFmt} | ${loc}`);
  }

  const embed = new EmbedBuilder()
    .setTitle(embedTitle)
    .setColor(0x6366F1)
    .setDescription(lines.join('\n'))
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

/**
 * Handles /import command: validates attachment, downloads JSON, and executes transactional ingestion
 */
export async function handleImportCommand(interaction, db = getDb()) {
  let user = getUserFromInteraction(interaction, db);
  if (!user && interaction.user?.id) {
    const code = generatePairingCode();
    db.prepare('INSERT INTO users (discord_user_id, pairing_code) VALUES (?, ?)').run(interaction.user.id, code);
    user = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(interaction.user.id);
  }
  if (!user) {
    return interaction.reply({
      content: '⚠️ Failed to identify your Discord user account. Please try running /start first.',
      ephemeral: true
    });
  }

  const attachment = interaction.options?.getAttachment
    ? interaction.options.getAttachment('file')
    : (interaction.options?.file || null);

  if (!attachment) {
    return interaction.reply({
      content: '⚠️ Please attach your `schedule_raw.json` file to the command.',
      ephemeral: true
    });
  }

  let jsonContent = null;
  if (attachment.content) {
    try {
      jsonContent = typeof attachment.content === 'string' ? JSON.parse(attachment.content) : attachment.content;
    } catch {
      return interaction.reply({
        content: '❌ Invalid JSON file. Please ensure the attached file contains valid JSON.',
        ephemeral: true
      });
    }
  } else if (attachment.url) {
    try {
      const resp = await fetch(attachment.url);
      if (!resp.ok) {
        return interaction.reply({
          content: `❌ Could not download attachment (HTTP ${resp.status}). Please try again.`,
          ephemeral: true
        });
      }
      const text = await resp.text();
      jsonContent = JSON.parse(text);
    } catch (err) {
      return interaction.reply({
        content: `❌ Failed to parse JSON file: ${err.message}`,
        ephemeral: true
      });
    }
  } else {
    return interaction.reply({
      content: '❌ No readable content found in attachment.',
      ephemeral: true
    });
  }

  try {
    const result = normalizeAndIngestPayload(jsonContent, db, user.id);

    const courseLines = result.importedCourses.map(c => 
      `• **${c.code}** (Sec ${c.section})${c.faculty ? ` • 👨‍🏫 ${c.faculty}` : ''}${c.room ? ` • 📍 ${c.room}` : ''}`
    ).join('\n') || 'Courses imported';

    const embed = new EmbedBuilder()
      .setTitle('🎉 BRACU Routine Imported Successfully!')
      .setDescription('Your routine and exam calendar have been linked to your Discord account.')
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
      .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], ephemeral: true });
  } catch (err) {
    await interaction.reply({
      content: `❌ Ingestion error: ${err.message}`,
      ephemeral: true
    });
  }
}

/**
 * Builds the StringSelectMenuBuilder dropdown for filtering the routine
 */
export function buildRoutineSelectMenu(selectedDay = 'ALL') {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('routine_day_select')
    .setPlaceholder('Filter by Day of Week')
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel('All Days')
        .setValue('ALL')
        .setDescription('View complete weekly routine')
        .setEmoji('📅')
        .setDefault(selectedDay === 'ALL'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Sunday')
        .setValue('SUNDAY')
        .setDescription('Sunday classes')
        .setEmoji('☀️')
        .setDefault(selectedDay === 'SUNDAY'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Monday')
        .setValue('MONDAY')
        .setDescription('Monday classes')
        .setEmoji('📖')
        .setDefault(selectedDay === 'MONDAY'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Tuesday')
        .setValue('TUESDAY')
        .setDescription('Tuesday classes')
        .setEmoji('💻')
        .setDefault(selectedDay === 'TUESDAY'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Wednesday')
        .setValue('WEDNESDAY')
        .setDescription('Wednesday classes')
        .setEmoji('🔬')
        .setDefault(selectedDay === 'WEDNESDAY'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Thursday')
        .setValue('THURSDAY')
        .setDescription('Thursday classes')
        .setEmoji('📚')
        .setDefault(selectedDay === 'THURSDAY'),
      new StringSelectMenuOptionBuilder()
        .setLabel('Saturday')
        .setValue('SATURDAY')
        .setDescription('Saturday classes')
        .setEmoji('🎯')
        .setDefault(selectedDay === 'SATURDAY')
    );

  return new ActionRowBuilder().addComponents(menu);
}

/**
 * Builds the EmbedBuilder for weekly routine or daily view
 */
export function buildRoutineEmbed(slots, selectedDay = 'ALL') {
  const dayOrder = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'SATURDAY'];
  const embed = new EmbedBuilder()
    .setColor(0x6366F1)
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka (+06:00)' })
    .setTimestamp();

  if (selectedDay === 'ALL') {
    embed.setTitle('📅 Weekly Class Routine Overview');
    if (slots.length === 0) {
      embed.setDescription('No classes found in your routine. Use `/import` to upload your `schedule_raw.json`!');
      return embed;
    }

    for (const day of dayOrder) {
      const daySlots = slots.filter(s => s.day_of_week === day);
      if (daySlots.length === 0) continue;

      const lines = daySlots.map(s => {
        const timeStr = `${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)}`;
        const roomStr = s.room ? `📍 \`${s.room}\`` : '📍 TBA';
        const facStr = s.faculty ? ` • 👨‍🏫 ${s.faculty}` : '';
        return `• **${s.code}** (Sec ${s.section}) | ⏰ \`${timeStr}\` | ${roomStr}${facStr}`;
      });

      embed.addFields({
        name: `🗓️ ${day.toUpperCase()} (${daySlots.length})`,
        value: lines.join('\n'),
        inline: false
      });
    }
  } else {
    const daySlots = slots.filter(s => s.day_of_week === selectedDay);
    embed.setTitle(`🗓️ Class Schedule: ${selectedDay.toUpperCase()}`);

    if (daySlots.length === 0) {
      embed.setDescription(`No classes scheduled for **${selectedDay}**. Enjoy your day off! 🎉`);
    } else {
      const lines = daySlots.map(s => {
        const timeStr = `${s.start_time.substring(0, 5)} - ${s.end_time.substring(0, 5)}`;
        const roomStr = s.room ? `📍 Room: \`${s.room}\`` : '📍 Room: TBA';
        const facStr = s.faculty ? `\n👨‍🏫 Faculty: **${s.faculty}**` : '';
        const nameStr = s.name ? `\n📖 *${s.name}*` : '';
        return `### **${s.code}** (Section ${s.section})\n⏰ **${timeStr}** • ${roomStr}${facStr}${nameStr}`;
      });

      embed.setDescription(lines.join('\n\n'));
    }
  }

  return embed;
}

/**
 * Handles /routine command: interactive routine viewer with dropdown
 */
export async function handleRoutineCommand(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ You have not set up your schedule yet! Run **/import** with your `schedule_raw.json` file.',
      ephemeral: true
    });
  }

  const slots = db.prepare(`
    SELECT r.day_of_week, r.start_time, r.end_time, r.room, c.code, c.name, c.section, c.faculty
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
        ELSE 8
      END,
      r.start_time ASC;
  `).all(user.id);

  const embed = buildRoutineEmbed(slots, 'ALL');
  const selectMenuRow = buildRoutineSelectMenu('ALL');

  await interaction.reply({
    embeds: [embed],
    components: [selectMenuRow],
    ephemeral: true
  });
}

/**
 * Handles StringSelectMenu submission for routine_day_select
 */
export async function handleRoutineSelectMenu(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ No schedule found.',
      ephemeral: true
    });
  }

  const selectedDay = interaction.values?.[0] || 'ALL';

  const slots = db.prepare(`
    SELECT r.day_of_week, r.start_time, r.end_time, r.room, c.code, c.name, c.section, c.faculty
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
        ELSE 8
      END,
      r.start_time ASC;
  `).all(user.id);

  const embed = buildRoutineEmbed(slots, selectedDay);
  const selectMenuRow = buildRoutineSelectMenu(selectedDay);

  await interaction.update({
    embeds: [embed],
    components: [selectMenuRow]
  });
}

/**
 * Handles /reset command: warning confirmation embed with Danger button
 */
export async function handleResetCommand(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.reply({
      content: '⚠️ No active schedule found to reset.',
      ephemeral: true
    });
  }

  const coursesCount = db.prepare('SELECT count(*) as c FROM courses WHERE user_id = ?').get(user.id).c;
  const slotsCount = db.prepare('SELECT count(*) as c FROM routine_slots WHERE user_id = ?').get(user.id).c;

  const warningEmbed = new EmbedBuilder()
    .setTitle('⚠️ Confirm Routine Reset')
    .setDescription(
      `Are you sure you want to reset your schedule?\n\n` +
      `This will permanently purge:\n` +
      `• **${coursesCount}** enrolled course(s)\n` +
      `• **${slotsCount}** weekly routine slot(s)\n` +
      `• All official university exam reminders\n` +
      `• All past notification history\n\n` +
      `*(Your custom tasks created via \`/addtask\` will remain safe and intact).*`
    )
    .setColor(0xEF4444)
    .setFooter({ text: 'FRIDAY Academic Assistant • Irreversible Action' });

  const confirmButton = new ButtonBuilder()
    .setCustomId('confirm_routine_reset')
    .setLabel('Confirm Reset')
    .setStyle(ButtonStyle.Danger)
    .setEmoji('🗑️');

  const row = new ActionRowBuilder().addComponents(confirmButton);

  await interaction.reply({
    embeds: [warningEmbed],
    components: [row],
    ephemeral: true
  });
}

/**
 * Handles confirm_routine_reset button click
 */
export async function handleConfirmResetButton(interaction, db = getDb()) {
  const user = getUserFromInteraction(interaction, db);
  if (!user) {
    return interaction.update({
      content: '⚠️ No user account found.',
      embeds: [],
      components: []
    });
  }

  // Detach custom events so foreign key cascade doesn't delete them
  db.prepare('UPDATE events SET course_id = NULL WHERE user_id = ? AND is_custom = 1').run(user.id);

  // Purge routine slots, automated events, courses, and notification logs for this user
  db.prepare('DELETE FROM routine_slots WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM events WHERE user_id = ? AND is_custom = 0').run(user.id);
  db.prepare('DELETE FROM courses WHERE user_id = ?').run(user.id);
  db.prepare('DELETE FROM notification_logs WHERE user_id = ?').run(user.id);

  await interaction.update({
    content: '✅ Routine wiped clean. Use /import to upload a new one.',
    embeds: [],
    components: []
  });
}

