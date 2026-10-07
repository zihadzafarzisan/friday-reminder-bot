import { initTestEnvironment, cleanDatabaseFiles } from '../src/db/test-helper.js';
import { createServer } from '../src/server.js';
import { runEvaluationTick, getDhakaContext, getStoredDiscordUserId } from '../src/reminder-engine.js';
import http from 'http';

function request(app, options, body = null) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const port = server.address().port;
      const req = http.request({ ...options, port, host: '127.0.0.1' }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          server.close();
          try {
            const parsed = JSON.parse(data);
            resolve({ status: res.statusCode, data: parsed });
          } catch (e) {
            resolve({ status: res.statusCode, text: data });
          }
        });
      });
      req.on('error', err => {
        server.close();
        reject(err);
      });
      if (body) {
        req.setHeader('Content-Type', 'application/json');
        req.write(JSON.stringify(body));
      }
      req.end();
    });
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('  RUNNING PHASE 4.1 BUG FIXES & SETTINGS TEST SUITE');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();
  const app = createServer();
  let passed = 0;
  let total = 0;

  function assert(condition, testName) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
    }
  }

  // TEST 1: Dhaka Context and Relative Date Parsing
  console.log('--- TEST GROUP 1: Timezone & Relative Date Parsing ---');
  const dhakaCtx = getDhakaContext(new Date());
  console.log(`Current Dhaka Context: Date=${dhakaCtx.dateStr}, Time=${dhakaCtx.timeStr}, Day=${dhakaCtx.dayOfWeek}`);

  // Simulate getDhakaDateString function as in index.html
  function getDhakaDateString(dateObjOrIso) {
    const d = new Date(dateObjOrIso);
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Dhaka',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(d);
  }

  // Today test: 2026-10-05 20:30 BST
  const testInputDhaka = `${dhakaCtx.dateStr}T20:30:00+06:00`;
  const eventDateStr = getDhakaDateString(testInputDhaka);
  const todayStr = getDhakaDateString(new Date());
  const todayMidnight = new Date(`${todayStr}T00:00:00+06:00`).getTime();
  const eventMidnight = new Date(`${eventDateStr}T00:00:00+06:00`).getTime();
  const diffDays = Math.round((eventMidnight - todayMidnight) / 86400000);

  assert(eventDateStr === dhakaCtx.dateStr, `Event date (${eventDateStr}) matches current Dhaka date (${dhakaCtx.dateStr})`);
  assert(diffDays === 0, `Setting ${dhakaCtx.dateStr} 20:30 resolves diffDays === 0 (displays "Today")`);

  // Tomorrow test
  const tomorrowMidnight = todayMidnight + 86400000;
  const tomorrowIso = new Date(tomorrowMidnight).toISOString();
  const tomorrowDateStr = getDhakaDateString(tomorrowIso);
  const tomorrowDiff = Math.round((new Date(`${tomorrowDateStr}T00:00:00+06:00`).getTime() - todayMidnight) / 86400000);
  assert(tomorrowDiff === 1, `Tomorrow date resolves diffDays === 1 (displays "Tomorrow")`);

  // TEST 2: Settings API (GET and POST /api/settings)
  console.log('\n--- TEST GROUP 2: Settings & Multi-User API ---');
  const initialSettingsRes = await request(app, { method: 'GET', path: '/api/settings' });
  assert(initialSettingsRes.status === 200 && initialSettingsRes.data.success, 'GET /api/settings returns 200 OK');
  assert(typeof initialSettingsRes.data.data.discord_user_id === 'string', 'Settings contains discord_user_id');

  // Update Settings with new Discord User ID and Passcode
  const testUserId = '999888777666555444';
  const testPass = 'secret1234';
  const saveRes = await request(app, { method: 'POST', path: '/api/settings' }, {
    discord_user_id: testUserId,
    user_name: 'Test Student',
    passcode: testPass
  });
  assert(saveRes.status === 200 && saveRes.data.success, 'POST /api/settings saves successfully');

  // Verify DB reflects updated discord_user_id
  const storedId = getStoredDiscordUserId(db);
  assert(storedId === testUserId, `getStoredDiscordUserId() returns updated ID: ${storedId}`);

  // Verify GET /api/settings reports has_passcode = true without exposing raw passcode
  const checkSettingsRes = await request(app, { method: 'GET', path: '/api/settings' });
  assert(checkSettingsRes.data.data.has_passcode === true, 'GET /api/settings indicates has_passcode = true');
  assert(checkSettingsRes.data.data.discord_user_id === testUserId, 'GET /api/settings returns updated discord_user_id');
  assert(checkSettingsRes.data.data.passcode === undefined, 'Raw passcode is NOT leaked in GET /api/settings');

  // Test Auth verify endpoint
  const failAuth = await request(app, { method: 'POST', path: '/api/auth/verify' }, { passcode: 'wrong' });
  assert(failAuth.status === 401 && !failAuth.data.verified, 'POST /api/auth/verify rejects wrong passcode with 401');

  const okAuth = await request(app, { method: 'POST', path: '/api/auth/verify' }, { passcode: testPass });
  assert(okAuth.status === 200 && okAuth.data.verified, 'POST /api/auth/verify accepts valid passcode with 200 OK');

  // Clear Passcode
  await request(app, { method: 'POST', path: '/api/settings' }, { passcode: '' });
  const clearedCheck = await request(app, { method: 'GET', path: '/api/settings' });
  assert(clearedCheck.data.data.has_passcode === false, 'Passcode can be cleared by sending empty string');

  // Restore real Discord user ID if available in .env
  if (process.env.DISCORD_USER_ID) {
    await request(app, { method: 'POST', path: '/api/settings' }, { discord_user_id: process.env.DISCORD_USER_ID });
  }

  // TEST 3: Event Creation and PUT Update
  console.log('\n--- TEST GROUP 3: Event Creation, Timezone Offset & PUT Update ---');
  // Create an event with datetime-local format: "YYYY-MM-DDTHH:mm"
  const createRes = await request(app, { method: 'POST', path: '/api/events' }, {
    title: 'Phase 4.1 Test Quiz',
    type: 'QUIZ',
    start_time: `${dhakaCtx.dateStr}T20:30`,
    room: '08H-22C'
  });
  assert(createRes.status === 200 && createRes.data.success, 'POST /api/events creates custom event');
  const createdId = createRes.data.data.id;

  // Verify created event has +06:00 offset preserved
  const createdRecord = db.prepare('SELECT * FROM events WHERE id = ?').get(createdId);
  assert(createdRecord.start_time === `${dhakaCtx.dateStr}T20:30:00+06:00`, `Stored start_time includes Asia/Dhaka offset (+06:00): ${createdRecord.start_time}`);

  // Test PUT /api/events/:id
  const putRes = await request(app, { method: 'PUT', path: `/api/events/${createdId}` }, {
    title: 'Phase 4.1 Updated Quiz Title',
    type: 'QUIZ',
    start_time: `${dhakaCtx.dateStr}T21:00`,
    room: 'Online Zoom'
  });
  assert(putRes.status === 200 && putRes.data.success, 'PUT /api/events/:id updates custom event');
  assert(putRes.data.data.title === 'Phase 4.1 Updated Quiz Title', 'PUT response contains updated title');
  assert(putRes.data.data.room === 'Online Zoom', 'PUT response contains updated room');
  assert(putRes.data.data.start_time === `${dhakaCtx.dateStr}T21:00:00+06:00`, `PUT updated start_time correctly formatted: ${putRes.data.data.start_time}`);

  // TEST 4: Reminder Engine Trigger Windows
  console.log('\n--- TEST GROUP 4: Reminder Engine Trigger Windows ---');
  // Let's test a simulated reference date 27 minutes before the event to test 30M window (25..30)
  const eventEpoch = new Date(`${dhakaCtx.dateStr}T21:00:00+06:00`).getTime();
  const simDate27m = new Date(eventEpoch - 27 * 60 * 1000);

  const dispatches27m = await runEvaluationTick({
    db,
    referenceDate: simDate27m,
    dryRun: true
  });
  const taskAlert = dispatches27m.find(d => d.eventKey === String(createdId));
  // Note: For custom tasks, the 24H, 1H, and 10M windows fire. At 27m, 1H is 50-60m and 10M is 5-10m.
  // Let's test at 8m before the event (10M_BEFORE window: 5..10m)
  const simDate8m = new Date(eventEpoch - 8 * 60 * 1000);
  const dispatches8m = await runEvaluationTick({
    db,
    referenceDate: simDate8m,
    dryRun: true
  });
  const taskAlert8m = dispatches8m.find(d => d.eventKey === String(createdId) && d.offset === '10M_BEFORE');
  assert(taskAlert8m !== undefined, 'Reminder engine triggers 10M_BEFORE alert for custom task at diff=8m');

  // Let's test at 55m before the event (1H_BEFORE window: 50..60m)
  const simDate55m = new Date(eventEpoch - 55 * 60 * 1000);
  const dispatches55m = await runEvaluationTick({
    db,
    referenceDate: simDate55m,
    dryRun: true
  });
  const taskAlert55m = dispatches55m.find(d => d.eventKey === String(createdId) && d.offset === '1H_BEFORE');
  assert(taskAlert55m !== undefined, 'Reminder engine triggers 1H_BEFORE alert for custom task at diff=55m');

  // TEST 5: Routine slot trigger windows
  // Find a routine slot
  const testSlot = db.prepare(`SELECT * FROM routine_slots LIMIT 1`).get();
  if (testSlot) {
    // Construct slot epoch on slot's day
    const days = ['SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY'];
    const currentDayIdx = new Date().getDay();
    const targetDayIdx = days.indexOf(testSlot.day_of_week);
    const dayOffset = (targetDayIdx - currentDayIdx + 7) % 7;
    const slotDate = new Date(Date.now() + dayOffset * 86400000);
    const slotDateStr = getDhakaDateString(slotDate);
    const slotStartEpoch = new Date(`${slotDateStr}T${testSlot.start_time}+06:00`).getTime();

    // 28 minutes before slot (30M window: 25..30m)
    const slotRefDate28m = new Date(slotStartEpoch - 28 * 60 * 1000);
    const slotDispatches = await runEvaluationTick({
      db,
      referenceDate: slotRefDate28m,
      dryRun: true
    });
    const routineAlert = slotDispatches.find(d => d.eventKey === `ROUTINE_${testSlot.id}_${slotDateStr}` && d.offset === '30M_BEFORE');
    assert(routineAlert !== undefined, `Routine slot triggers 30M_BEFORE in 25-30m window (at 28m diff)`);
  }

  // Clean up test event
  await request(app, { method: 'DELETE', path: `/api/events/${createdId}` });
  const checkDeleted = db.prepare('SELECT id FROM events WHERE id = ?').get(createdId);
  assert(!checkDeleted, 'Test event cleaned up after verification');

  console.log(`\n====================================================`);
  console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed/total)*100)}%)`);
  console.log(`====================================================`);

  cleanup();

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[FATAL] Test runner failed:', err);
  try {
    cleanDatabaseFiles(process.env.DB_PATH);
  } catch {}
  process.exit(1);
});
