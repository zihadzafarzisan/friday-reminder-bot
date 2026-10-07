import assert from 'assert';
import http from 'http';
import { getDb } from '../src/db/index.js';
import { runMigration } from '../src/db/migrate.js';
import { createServer } from '../src/server.js';
import { closeDiscordClient } from '../src/bot.js';
import { 
  handleStartCommand, 
  handleTodayCommand, 
  handleNextCommand, 
  handleDeadlinesCommand, 
  handleTaskModalSubmit, 
  handleTaskButton 
} from '../src/commands/handlers.js';
import { runEvaluationTick, getDhakaContext } from '../src/reminder-engine.js';
import { normalizeAndIngestPayload } from '../src/normalize.js';

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

async function request(server, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { 'Content-Type': 'application/json', ...headers };
    const req = http.request({
      hostname: 'localhost',
      port,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('  TESTING PHASE 5: MULTI-TENANT ARCHITECTURE & PORTAL');
  console.log('====================================================\n');

  const db = getDb();
  runMigration(db);

  // --- TEST GROUP 1: Database Schema & Default User #1 Preservation ---
  console.log('--- TEST GROUP 1: Database Schema & User #1 Data Preservation ---');
  
  const user1 = db.prepare('SELECT * FROM users WHERE id = 1').get();
  it('User #1 exists with Discord ID', () => {
    assert.ok(user1, 'User #1 should exist');
    assert.strictEqual(user1.discord_user_id, '1328051283080380559');
  });

  const user1Courses = db.prepare('SELECT code, section FROM courses WHERE user_id = 1 ORDER BY code ASC').all();
  it('User #1 preserves existing courses (CSE230, HUM101, MAT216)', () => {
    const codes = user1Courses.map(c => c.code);
    assert.ok(codes.includes('CSE230'), 'CSE230 must exist for User #1');
    assert.ok(codes.includes('HUM101'), 'HUM101 must exist for User #1');
    assert.ok(codes.includes('MAT216'), 'MAT216 must exist for User #1');
  });

  const user1Slots = db.prepare('SELECT count(*) as c FROM routine_slots WHERE user_id = 1').get();
  it('User #1 routine slots are preserved and scoped to user_id = 1', () => {
    assert.ok(user1Slots.c >= 6, `Expected >= 6 slots, found ${user1Slots.c}`);
  });

  const user1Events = db.prepare('SELECT count(*) as c FROM events WHERE user_id = 1').get();
  it('User #1 exam events are preserved and scoped to user_id = 1', () => {
    assert.ok(user1Events.c >= 6, `Expected >= 6 events, found ${user1Events.c}`);
  });

  // --- TEST GROUP 2: Discord Onboarding (/start) & Pairing Code Generation ---
  console.log('\n--- TEST GROUP 2: Discord Onboarding (/start) & Pairing Code ---');

  const testDiscordId2 = '888777666555444333';
  let capturedReply = null;
  const mockStartInteraction = {
    user: { id: testDiscordId2, username: 'NewStudentTanvir' },
    reply: (payload) => { capturedReply = payload; }
  };

  // Clean test user 2 if exists
  db.prepare('DELETE FROM users WHERE discord_user_id = ?').run(testDiscordId2);

  await itAsync('/start creates new user and generates unique pairing code', async () => {
    await handleStartCommand(mockStartInteraction, db);
    const createdUser2 = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(testDiscordId2);
    assert.ok(createdUser2, 'User 2 row must be created');
    assert.ok(createdUser2.pairing_code, 'Pairing code must be generated');
    assert.ok(createdUser2.pairing_code.startsWith('BRC-'), 'Pairing code should start with BRC-');
    assert.ok(capturedReply.ephemeral, 'Reply must be ephemeral for privacy');
    assert.ok(capturedReply.embeds[0].data.title.includes('Welcome to BRACU Connect'), 'Title must be welcoming');
  });

  const user2 = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(testDiscordId2);

  await itAsync('/start returns existing pairing code if run again', async () => {
    capturedReply = null;
    await handleStartCommand(mockStartInteraction, db);
    const again = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(testDiscordId2);
    assert.strictEqual(again.pairing_code, user2.pairing_code, 'Pairing code should be stable');
  });

  // --- TEST GROUP 3: Web Ingestion Portal (/api/user/import-schedule) ---
  console.log('\n--- TEST GROUP 3: Ingestion Portal API (POST /api/user/import-schedule) ---');

  const app = createServer();
  const server = app.listen(0);

  // Sample schedule payload for User 2 (taking different courses: ENG101 & PHY111)
  const user2RawSchedule = [
    {
      courseCode: 'ENG101',
      sectionName: '03',
      name: 'English Fundamentals',
      faculties: 'RAK',
      roomNumber: 'UB0201',
      courseCredit: '3.0',
      sectionSchedule: JSON.stringify({
        classSchedules: [
          { day: 'SUNDAY', startTime: '11:00:00', endTime: '12:20:00', roomNo: 'UB0201' },
          { day: 'TUESDAY', startTime: '11:00:00', endTime: '12:20:00', roomNo: 'UB0201' }
        ],
        midExamDate: '2026-11-10',
        midExamStartTime: '11:00:00',
        midExamEndTime: '13:00:00'
      })
    },
    {
      courseCode: 'PHY111',
      sectionName: '01',
      name: 'Principles of Physics I',
      faculties: 'MSH',
      roomNumber: 'UB0502',
      courseCredit: '3.0',
      sectionSchedule: JSON.stringify({
        classSchedules: [
          { day: 'MONDAY', startTime: '09:30:00', endTime: '10:50:00', roomNo: 'UB0502' },
          { day: 'WEDNESDAY', startTime: '09:30:00', endTime: '10:50:00', roomNo: 'UB0502' }
        ],
        finalExamDate: '2026-12-20',
        finalExamStartTime: '09:00:00',
        finalExamEndTime: '12:00:00'
      })
    }
  ];

  await itAsync('POST /api/user/import-schedule rejects invalid pairing code', async () => {
    const res = await request(server, '/api/user/import-schedule', 'POST', {
      pairing_code: 'INVALID_CODE_999',
      schedule_data: user2RawSchedule
    });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.body.success, false);
  });

  await itAsync('POST /api/user/import-schedule ingests schedule for User #2', async () => {
    const res = await request(server, '/api/user/import-schedule', 'POST', {
      pairing_code: user2.pairing_code,
      schedule_data: user2RawSchedule
    });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.user_id, user2.id);
    assert.strictEqual(res.body.data.coursesInserted, 2);
    assert.strictEqual(res.body.data.routineSlotsInserted, 4);
    assert.strictEqual(res.body.data.eventsInserted, 2);
  });

  it('User #2 courses are strictly isolated in courses table', () => {
    const u2Courses = db.prepare('SELECT code, section FROM courses WHERE user_id = ? ORDER BY code ASC').all(user2.id);
    assert.strictEqual(u2Courses.length, 2);
    assert.strictEqual(u2Courses[0].code, 'ENG101');
    assert.strictEqual(u2Courses[1].code, 'PHY111');
  });

  it('User #1 courses remain completely untouched by User #2 ingestion', () => {
    const u1Courses = db.prepare('SELECT code FROM courses WHERE user_id = 1 ORDER BY code ASC').all();
    const codes = u1Courses.map(c => c.code);
    assert.ok(!codes.includes('ENG101'), 'User 1 should not have ENG101');
    assert.ok(!codes.includes('PHY111'), 'User 1 should not have PHY111');
    assert.ok(codes.includes('CSE230'), 'User 1 must still have CSE230');
  });

  // --- TEST GROUP 4: Per-User Command Scoping (/today, /next, /deadlines, /addtask) ---
  console.log('\n--- TEST GROUP 4: Per-User Command Scoping ---');

  await itAsync('Unregistered user running /today receives prompt to run /start', async () => {
    let unregReply = null;
    const mockUnreg = {
      user: { id: '999999999999999999' },
      reply: (p) => { unregReply = p; }
    };
    await handleTodayCommand(mockUnreg, db);
    assert.ok(unregReply.content.includes('/start'), 'Should prompt to run /start');
  });

  await itAsync('User #2 running /deadlines only sees their own exams/deadlines', async () => {
    let u2Reply = null;
    const mockU2 = {
      user: { id: testDiscordId2 },
      reply: (p) => { u2Reply = p; }
    };
    await handleDeadlinesCommand(mockU2, db);
    assert.ok(u2Reply.embeds[0], 'Should reply with Embed');
    const fields = u2Reply.embeds[0].data.fields;
    const text = JSON.stringify(fields);
    assert.ok(text.includes('ENG101'), 'User 2 deadlines should list ENG101');
    assert.ok(!text.includes('HUM101'), 'User 2 deadlines must NOT contain User 1 courses (HUM101)');
  });

  await itAsync('User #2 adding custom task via /addtask is scoped to user_id = 2', async () => {
    const mockModalSubmit = {
      user: { id: testDiscordId2 },
      fields: {
        getTextInputValue: (field) => {
          if (field === 'task_course') return 'ENG101';
          if (field === 'task_type') return 'QUIZ';
          if (field === 'task_title') return 'ENG101 Essay Draft';
          if (field === 'task_datetime') return '2026-10-07 14:00';
          if (field === 'task_room') return 'UB0201';
          return '';
        }
      },
      reply: (p) => {}
    };

    await handleTaskModalSubmit(mockModalSubmit, db);
    const createdTask = db.prepare("SELECT * FROM events WHERE title = 'ENG101 Essay Draft'").get();
    assert.ok(createdTask, 'Task must be created');
    assert.strictEqual(createdTask.user_id, user2.id, 'Task must be scoped to user_id = 2');
    assert.strictEqual(createdTask.is_custom, 1);
  });

  await itAsync('User #2 completing task via button deletes task and logs for user_id = 2', async () => {
    const createdTask = db.prepare("SELECT * FROM events WHERE title = 'ENG101 Essay Draft'").get();
    let btnUpdate = null;
    const mockBtn = {
      user: { id: testDiscordId2, username: 'NewStudentTanvir' },
      customId: `complete_task_${createdTask.id}`,
      message: { embeds: [{ title: 'ENG101 Essay Draft' }] },
      update: (p) => { btnUpdate = p; }
    };

    await handleTaskButton(mockBtn, db);
    const checkDeleted = db.prepare('SELECT * FROM events WHERE id = ?').get(createdTask.id);
    assert.strictEqual(checkDeleted, undefined, 'Event should be deleted');
    const logCheck = db.prepare('SELECT * FROM notification_logs WHERE user_id = ? AND event_id = ?').get(user2.id, String(createdTask.id));
    assert.ok(logCheck, 'Suppression log must be created for user_id = 2');
    assert.strictEqual(logCheck.status, 'COMPLETED');
  });

  // --- TEST GROUP 5: Multi-Tenant Reminder Engine Loop ---
  console.log('\n--- TEST GROUP 5: Multi-Tenant Reminder Engine Loop ---');

  // Insert a test routine slot for User #2 due in 28 minutes
  const mockRefDate = new Date('2026-10-05T14:00:00+06:00');
  const { dateStr, dayOfWeek } = getDhakaContext(mockRefDate);
  const slotDate = new Date(mockRefDate.getTime() + 28 * 60 * 1000);
  const { timeStr: testStartTime } = getDhakaContext(slotDate);
  const testEndTime = '15:30:00';

  const user2EngCourse = db.prepare('SELECT id FROM courses WHERE user_id = ? AND code = ?').get(user2.id, 'ENG101');
  const insertedSlot = db.prepare(`
    INSERT INTO routine_slots (user_id, course_id, day_of_week, start_time, end_time, room)
    VALUES (?, ?, ?, ?, ?, 'UB0201')
    RETURNING id;
  `).get(user2.id, user2EngCourse.id, dayOfWeek, testStartTime, testEndTime);

  await itAsync('Reminder engine loops all users and triggers alert for User #2', async () => {
    const dispatches = await runEvaluationTick({ db, referenceDate: mockRefDate, dryRun: false });
    const u2Alert = dispatches.find(d => d.userId === user2.id && d.course === 'ENG101');
    assert.ok(u2Alert, 'Expected 30M_BEFORE alert for User 2 ENG101');
    assert.strictEqual(u2Alert.offset, '30M_BEFORE');
    assert.strictEqual(u2Alert.targetDiscordUserId, testDiscordId2);

    const logEntry = db.prepare('SELECT * FROM notification_logs WHERE user_id = ? AND event_id = ?').get(
      user2.id,
      `ROUTINE_${insertedSlot.id}_${dateStr}`
    );
    assert.ok(logEntry, 'Notification log must be recorded for user_id = 2');
    assert.strictEqual(logEntry.user_id, user2.id);
  });

  // Clean up temporary slot
  db.prepare('DELETE FROM routine_slots WHERE id = ?').run(insertedSlot.id);

  // --- TEST GROUP 6: Web Dashboard Endpoints Scoped by User ---
  console.log('\n--- TEST GROUP 6: Web Dashboard Endpoints (Multi-Tenant) ---');

  await itAsync('GET /api/users returns both registered users', async () => {
    const res = await request(server, '/api/users');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    const users = res.body.data;
    assert.ok(users.length >= 2, 'Should return at least 2 users');
    const u1 = users.find(u => u.id === 1);
    const u2 = users.find(u => u.id === user2.id);
    assert.ok(u1, 'User 1 must be in users list');
    assert.ok(u2, 'User 2 must be in users list');
    assert.strictEqual(u2.courses_count, 2);
  });

  await itAsync('GET /api/courses?user_id=2 returns User #2 courses only', async () => {
    const res = await request(server, `/api/courses?user_id=${user2.id}`);
    assert.strictEqual(res.status, 200);
    const courses = res.body.data;
    assert.strictEqual(courses.length, 2);
    assert.strictEqual(courses[0].code, 'ENG101');
  });

  await itAsync('GET /api/routine?user_id=2 returns User #2 routine slots', async () => {
    const res = await request(server, `/api/routine?user_id=${user2.id}`);
    assert.strictEqual(res.status, 200);
    const slots = res.body.data.slots;
    assert.strictEqual(slots.length, 4);
    assert.strictEqual(slots[0].code, 'ENG101');
  });

  server.close();
  await closeDiscordClient();

  console.log('\n====================================================');
  console.log(`  PHASE 5 TEST RESULTS: ${passed}/${passed + failed} TESTS PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('====================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(async (err) => {
  console.error('[!] Test suite fatal error:', err);
  await closeDiscordClient();
  process.exit(1);
});
