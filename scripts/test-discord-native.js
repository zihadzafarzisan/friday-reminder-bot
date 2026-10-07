import assert from 'assert';
import { initTestEnvironment, cleanDatabaseFiles } from '../src/db/test-helper.js';
import { 
  handleImportCommand,
  handleRoutineCommand,
  handleRoutineSelectMenu,
  handleResetCommand,
  handleConfirmResetButton,
  buildRoutineSelectMenu,
  buildRoutineEmbed,
  handleInteraction 
} from '../src/commands/handlers.js';
import { slashCommands } from '../src/commands/register.js';

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

function createMockChatInteraction(commandName, options = {}, userId = '777666555444333222') {
  let replyPayload = null;
  return {
    commandName,
    user: { id: userId, username: 'DiscordNativeStudent' },
    options: {
      getAttachment: (name) => options[name] || null,
      ...options
    },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isAnySelectMenu: () => false,
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    getReply: () => replyPayload
  };
}

function createMockSelectInteraction(customId, values, userId = '777666555444333222') {
  let updatePayload = null;
  return {
    customId,
    values,
    user: { id: userId, username: 'DiscordNativeStudent' },
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => true,
    isAnySelectMenu: () => true,
    update: async (payload) => {
      updatePayload = payload;
      return payload;
    },
    getUpdate: () => updatePayload
  };
}

function createMockButtonInteraction(customId, userId = '777666555444333222') {
  let updatePayload = null;
  return {
    customId,
    user: { id: userId, username: 'DiscordNativeStudent' },
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    isStringSelectMenu: () => false,
    isAnySelectMenu: () => false,
    update: async (payload) => {
      updatePayload = payload;
      return payload;
    },
    getUpdate: () => updatePayload
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('  TEST SUITE: 100% DISCORD-NATIVE AUTOMATION');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();

  const testDiscordId = '777666555444333222';
  db.prepare('DELETE FROM users WHERE discord_user_id = ?').run(testDiscordId);

  // Sample valid raw JSON schedule payload
  const sampleSchedule = [
    {
      courseCode: 'CSE230',
      sectionName: '05',
      name: 'Discrete Mathematics',
      faculties: 'TSM',
      roomNumber: '08H-22C',
      courseCredit: '3.0',
      sectionSchedule: JSON.stringify({
        classSchedules: [
          { day: 'MONDAY', startTime: '11:00:00', endTime: '12:20:00', roomNo: '08H-22C' },
          { day: 'WEDNESDAY', startTime: '11:00:00', endTime: '12:20:00', roomNo: '08H-22C' }
        ],
        midExamDate: '2026-07-28',
        midExamStartTime: '08:30:00',
        midExamEndTime: '10:30:00',
        finalExamDate: '2026-09-15',
        finalExamStartTime: '08:30:00',
        finalExamEndTime: '10:30:00'
      })
    },
    {
      courseCode: 'HUM101',
      sectionName: '14',
      name: 'World Civilization and Culture',
      faculties: 'MFC',
      roomNumber: '09G-28C',
      courseCredit: '3.0',
      sectionSchedule: JSON.stringify({
        classSchedules: [
          { day: 'SUNDAY', startTime: '14:00:00', endTime: '15:20:00', roomNo: '09G-28C' },
          { day: 'TUESDAY', startTime: '14:00:00', endTime: '15:20:00', roomNo: '09G-28C' }
        ],
        midExamDate: '2026-07-27',
        midExamStartTime: '14:00:00',
        midExamEndTime: '16:00:00',
        finalExamDate: '2026-09-14',
        finalExamStartTime: '14:00:00',
        finalExamEndTime: '16:00:00'
      })
    }
  ];

  // --- TEST GROUP 1: Slash Command Definitions ---
  console.log('--- TEST GROUP 1: Slash Command Definitions ---');

  it('slashCommands includes /import with attachment option "file"', () => {
    const importCmd = slashCommands.find(c => c.name === 'import');
    assert.ok(importCmd, '/import slash command must exist');
    const json = importCmd.toJSON();
    const fileOpt = json.options.find(o => o.name === 'file');
    assert.ok(fileOpt, 'Attachment option "file" must exist');
    assert.strictEqual(fileOpt.required, true, 'Attachment option must be required');
    assert.strictEqual(fileOpt.type, 11, 'Attachment option type must be 11 (ATTACHMENT)');
  });

  it('slashCommands includes /routine', () => {
    const routineCmd = slashCommands.find(c => c.name === 'routine');
    assert.ok(routineCmd, '/routine slash command must exist');
  });

  it('slashCommands includes /reset', () => {
    const resetCmd = slashCommands.find(c => c.name === 'reset');
    assert.ok(resetCmd, '/reset slash command must exist');
  });

  // --- TEST GROUP 2: Discord-Native Ingestion (/import) ---
  console.log('\n--- TEST GROUP 2: Discord-Native Schedule Ingestion (/import) ---');

  await itAsync('handleImportCommand rejects missing attachment', async () => {
    const inter = createMockChatInteraction('import', { file: null }, testDiscordId);
    await handleImportCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true);
    assert.ok(reply.content.includes('attach your `schedule_raw.json` file'));
  });

  await itAsync('handleImportCommand rejects invalid JSON attachment', async () => {
    const inter = createMockChatInteraction('import', {
      file: { name: 'bad.json', content: 'NOT_VALID_JSON{{{' }
    }, testDiscordId);
    await handleImportCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true);
    assert.ok(reply.content.includes('Invalid JSON'));
  });

  await itAsync('handleImportCommand ingests valid JSON and replies with ephemeral summary embed', async () => {
    const inter = createMockChatInteraction('import', {
      file: { name: 'schedule_raw.json', content: JSON.stringify(sampleSchedule) }
    }, testDiscordId);

    await handleImportCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true, 'Import response must be ephemeral');
    assert.ok(reply.embeds && reply.embeds.length > 0, 'Embed summary must be returned');

    const embed = reply.embeds[0].data;
    assert.ok(embed.title.includes('Routine Imported Successfully'));

    // Verify database state for this user
    const user = db.prepare('SELECT id FROM users WHERE discord_user_id = ?').get(testDiscordId);
    assert.ok(user, 'User row must be created');

    const courses = db.prepare('SELECT code FROM courses WHERE user_id = ? ORDER BY code ASC').all(user.id);
    assert.strictEqual(courses.length, 2);
    assert.strictEqual(courses[0].code, 'CSE230');
    assert.strictEqual(courses[1].code, 'HUM101');

    const slots = db.prepare('SELECT count(*) as c FROM routine_slots WHERE user_id = ?').get(user.id).c;
    assert.strictEqual(slots, 4, 'Should have 4 weekly slots');

    const events = db.prepare('SELECT count(*) as c FROM events WHERE user_id = ? AND is_custom = 0').get(user.id).c;
    assert.strictEqual(events, 4, 'Should have 4 exam events (2 midterms + 2 finals)');
  });

  const testUser = db.prepare('SELECT id FROM users WHERE discord_user_id = ?').get(testDiscordId);

  // --- TEST GROUP 3: Interactive Routine Viewer (/routine) ---
  console.log('\n--- TEST GROUP 3: Interactive Routine Viewer (/routine) ---');

  it('buildRoutineSelectMenu creates 7 filter options', () => {
    const row = buildRoutineSelectMenu('ALL');
    const menu = row.components[0];
    assert.strictEqual(menu.data.custom_id, 'routine_day_select');
    assert.strictEqual(menu.options.length, 7);
    const values = menu.options.map(o => o.data.value);
    assert.ok(values.includes('ALL'));
    assert.ok(values.includes('SUNDAY'));
    assert.ok(values.includes('MONDAY'));
    assert.ok(values.includes('TUESDAY'));
    assert.ok(values.includes('WEDNESDAY'));
    assert.ok(values.includes('THURSDAY'));
    assert.ok(values.includes('SATURDAY'));
  });

  await itAsync('handleRoutineCommand responds with overview embed and select menu', async () => {
    const inter = createMockChatInteraction('routine', {}, testDiscordId);
    await handleRoutineCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true);
    assert.ok(reply.embeds && reply.embeds.length > 0);
    assert.ok(reply.embeds[0].data.title.includes('Weekly Class Routine Overview'));
    assert.strictEqual(reply.components.length, 1);
    assert.strictEqual(reply.components[0].components[0].data.custom_id, 'routine_day_select');
  });

  await itAsync('handleRoutineSelectMenu filters in-place by MONDAY', async () => {
    const inter = createMockSelectInteraction('routine_day_select', ['MONDAY'], testDiscordId);
    await handleRoutineSelectMenu(inter, db);
    const update = inter.getUpdate();
    assert.ok(update, 'Update must be dispatched');
    assert.ok(update.embeds[0].data.title.includes('MONDAY'));
    assert.ok(update.embeds[0].data.description.includes('CSE230'));
    assert.ok(update.embeds[0].data.description.includes('11:00 - 12:20'));
    assert.ok(update.embeds[0].data.description.includes('08H-22C'));
  });

  await itAsync('handleRoutineSelectMenu displays day-off message for days with no classes', async () => {
    const inter = createMockSelectInteraction('routine_day_select', ['THURSDAY'], testDiscordId);
    await handleRoutineSelectMenu(inter, db);
    const update = inter.getUpdate();
    assert.ok(update, 'Update must be dispatched');
    assert.ok(update.embeds[0].data.title.includes('THURSDAY'));
    assert.ok(update.embeds[0].data.description.includes('No classes scheduled for **THURSDAY**'));
  });

  // --- TEST GROUP 4: Reset Routine Command (/reset & Button) ---
  console.log('\n--- TEST GROUP 4: Reset Routine Command (/reset) ---');

  // Insert a custom task (is_custom = 1) to verify it is preserved
  const customTask = db.prepare(`
    INSERT INTO events (user_id, type, title, start_time, end_time, is_custom)
    VALUES (?, 'ASSIGNMENT', 'My Preserved Custom Task', '2026-10-25T14:00:00+06:00', '2026-10-25T15:00:00+06:00', 1)
    RETURNING id;
  `).get(testUser.id);

  // Insert a dummy notification log
  db.prepare(`
    INSERT INTO notification_logs (user_id, event_id, notification_type, status)
    VALUES (?, 'EVENT_1', '1H_BEFORE', 'SENT');
  `).run(testUser.id);

  await itAsync('handleResetCommand responds with warning embed and Danger confirm button', async () => {
    const inter = createMockChatInteraction('reset', {}, testDiscordId);
    await handleResetCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true);
    assert.ok(reply.embeds[0].data.title.includes('Confirm Routine Reset'));
    assert.strictEqual(reply.components.length, 1);
    const btn = reply.components[0].components[0];
    assert.strictEqual(btn.data.custom_id, 'confirm_routine_reset');
    assert.strictEqual(btn.data.style, 4, 'Button style must be Danger (4)');
  });

  await itAsync('handleConfirmResetButton purges routine slots while preserving user existence and manual tasks', async () => {
    const inter = createMockButtonInteraction('confirm_routine_reset', testDiscordId);
    await handleConfirmResetButton(inter, db);
    const update = inter.getUpdate();
    assert.ok(update, 'Update must be dispatched');
    assert.ok(update.content.includes('Routine wiped clean'));

    // 1. Verify routine_slots purged
    const slotsCount = db.prepare('SELECT count(*) as c FROM routine_slots WHERE user_id = ?').get(testUser.id).c;
    assert.strictEqual(slotsCount, 0, 'Routine slots must be 0');

    // 2. Verify courses purged
    const coursesCount = db.prepare('SELECT count(*) as c FROM courses WHERE user_id = ?').get(testUser.id).c;
    assert.strictEqual(coursesCount, 0, 'Courses must be 0');

    // 3. Verify automated events purged
    const autoEventsCount = db.prepare('SELECT count(*) as c FROM events WHERE user_id = ? AND is_custom = 0').get(testUser.id).c;
    assert.strictEqual(autoEventsCount, 0, 'Automated events must be 0');

    // 4. Verify notification logs purged
    const logsCount = db.prepare('SELECT count(*) as c FROM notification_logs WHERE user_id = ?').get(testUser.id).c;
    assert.strictEqual(logsCount, 0, 'Notification logs must be 0');

    // 5. Verify user still exists
    const userStillExists = db.prepare('SELECT id FROM users WHERE id = ?').get(testUser.id);
    assert.ok(userStillExists, 'User row must remain intact');

    // 6. Verify manual custom task is preserved!
    const preservedTask = db.prepare('SELECT * FROM events WHERE id = ?').get(customTask.id);
    assert.ok(preservedTask, 'Custom task (is_custom = 1) must be preserved');
    assert.strictEqual(preservedTask.title, 'My Preserved Custom Task');
  });

  // --- TEST GROUP 5: Universal handleInteraction Router ---
  console.log('\n--- TEST GROUP 5: Universal handleInteraction Router ---');

  await itAsync('handleInteraction routes /import correctly', async () => {
    const inter = createMockChatInteraction('import', {
      file: { name: 'schedule_raw.json', content: JSON.stringify(sampleSchedule) }
    }, testDiscordId);
    await handleInteraction(inter, db);
    assert.ok(inter.getReply().embeds, 'Router must handle /import');
  });

  await itAsync('handleInteraction routes /routine correctly', async () => {
    const inter = createMockChatInteraction('routine', {}, testDiscordId);
    await handleInteraction(inter, db);
    assert.ok(inter.getReply().components, 'Router must handle /routine');
  });

  await itAsync('handleInteraction routes routine_day_select select menu correctly', async () => {
    const inter = createMockSelectInteraction('routine_day_select', ['WEDNESDAY'], testDiscordId);
    await handleInteraction(inter, db);
    assert.ok(inter.getUpdate().embeds, 'Router must handle routine_day_select');
  });

  await itAsync('handleInteraction routes /reset correctly', async () => {
    const inter = createMockChatInteraction('reset', {}, testDiscordId);
    await handleInteraction(inter, db);
    assert.ok(inter.getReply().components, 'Router must handle /reset');
  });

  await itAsync('handleInteraction routes confirm_routine_reset button correctly', async () => {
    const inter = createMockButtonInteraction('confirm_routine_reset', testDiscordId);
    await handleInteraction(inter, db);
    assert.ok(inter.getUpdate().content.includes('Routine wiped clean'), 'Router must handle confirm_routine_reset');
  });

  // Clean test user data
  db.prepare('DELETE FROM users WHERE discord_user_id = ?').run(testDiscordId);
  cleanup();

  console.log('\n====================================================');
  console.log(`  DISCORD-NATIVE TEST RESULTS: ${passed}/${passed + failed} PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[!] Test suite crashed:', err);
  try {
    cleanDatabaseFiles(process.env.DB_PATH);
  } catch {}
  process.exit(1);
});
