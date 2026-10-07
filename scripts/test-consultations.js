import assert from 'assert';
import http from 'http';
import { getDb } from '../src/db/index.js';
import { runMigration } from '../src/db/migrate.js';
import { createServer } from '../src/server.js';
import { 
  buildConsultationModal,
  handleConsultationCommand,
  handleConsultationModalSubmit,
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

function createMockChatInteraction(commandName) {
  let replyPayload = null;
  let shownModal = null;
  return {
    commandName,
    user: { id: '1328051283080380559', username: 'TestStudent' },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    showModal: async (modal) => {
      shownModal = modal;
      return modal;
    },
    getReply: () => replyPayload,
    getModal: () => shownModal
  };
}

function createMockModalInteraction(customId, fields) {
  let replyPayload = null;
  return {
    customId,
    user: { id: '1328051283080380559', username: 'TestStudent' },
    fields: {
      getTextInputValue: (id) => fields[id] || '',
      ...fields
    },
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isButton: () => false,
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    getReply: () => replyPayload
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('  TEST SUITE: FACULTY CONSULTATION & DISCORD MODAL');
  console.log('====================================================\n');

  const db = getDb();
  runMigration(db);

  // Clean test faculty data
  db.prepare("DELETE FROM faculty_consultations WHERE faculty_initial IN ('MSI', 'TSM', 'TESTFAC')").run();

  // --- TEST GROUP 1: Database Schema & Case-Insensitive Queries ---
  console.log('--- TEST GROUP 1: Database Schema & Case-Insensitive Queries ---');

  it('faculty_consultations table and index exist', () => {
    const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='faculty_consultations'").get();
    assert.ok(table, 'faculty_consultations table must exist');

    const index = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_faculty_initial'").get();
    assert.ok(index, 'idx_faculty_initial index must exist');
  });

  it('Can insert consultation slots into database', () => {
    const insertStmt = db.prepare(`
      INSERT INTO faculty_consultations (
        faculty_initial, faculty_name, day_of_week, start_time, end_time, room, contact_email, consultation_link
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    insertStmt.run('MSI', 'Md. Saiful Islam', 'SUNDAY', '14:00', '15:30', 'UB0821', 'msi@bracu.ac.bd', 'https://meet.google.com/msi-sunday');
    insertStmt.run('MSI', 'Md. Saiful Islam', 'TUESDAY', '14:00', '15:30', 'UB0821', 'msi@bracu.ac.bd', 'https://meet.google.com/msi-tuesday');

    const count = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'MSI'").get().c;
    assert.strictEqual(count, 2, 'Should have 2 consultation slots for MSI');
  });

  it('Queries consultation slots case-insensitively (MSI, msi, mSi)', () => {
    const upper = db.prepare("SELECT * FROM faculty_consultations WHERE faculty_initial = ? COLLATE NOCASE").all('MSI');
    assert.strictEqual(upper.length, 2);

    const lower = db.prepare("SELECT * FROM faculty_consultations WHERE faculty_initial = ? COLLATE NOCASE").all('msi');
    assert.strictEqual(lower.length, 2);

    const mixed = db.prepare("SELECT * FROM faculty_consultations WHERE faculty_initial = ? COLLATE NOCASE").all('mSi');
    assert.strictEqual(mixed.length, 2);
  });

  it('Returns empty array for non-existent faculty initial', () => {
    const none = db.prepare("SELECT * FROM faculty_consultations WHERE faculty_initial = ? COLLATE NOCASE").all('NONEXISTENT_999');
    assert.strictEqual(none.length, 0);
  });

  // --- TEST GROUP 2: Slash Command Registration & Modal Handlers ---
  console.log('\n--- TEST GROUP 2: Slash Command Registration & Modal Handlers ---');

  it('slashCommands list includes /consultation', () => {
    const cmd = slashCommands.find(c => c.name === 'consultation');
    assert.ok(cmd, '/consultation slash command definition must exist');
    assert.ok(cmd.description.toLowerCase().includes('consultation'));
  });

  it('buildConsultationModal builds correct modal structure', () => {
    const modal = buildConsultationModal();
    assert.strictEqual(modal.data.custom_id, 'faculty_consultation_modal');
    assert.strictEqual(modal.data.title, 'Faculty Consultation Lookup');
    assert.strictEqual(modal.components.length, 1);

    const textInput = modal.components[0].components[0];
    assert.strictEqual(textInput.data.custom_id, 'faculty_initial');
    assert.strictEqual(textInput.data.label, 'Faculty Initial');
  });

  await itAsync('handleConsultationCommand shows modal to user', async () => {
    const interaction = createMockChatInteraction('consultation');
    await handleConsultationCommand(interaction);
    const modal = interaction.getModal();
    assert.ok(modal, 'Modal must be shown');
    assert.strictEqual(modal.data.custom_id, 'faculty_consultation_modal');
  });

  await itAsync('handleConsultationModalSubmit returns formatted ephemeral embed for found faculty', async () => {
    const interaction = createMockModalInteraction('faculty_consultation_modal', { faculty_initial: 'msi' });
    await handleConsultationModalSubmit(interaction, db);
    const reply = interaction.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true, 'Discord response must be strictly ephemeral');
    assert.ok(reply.embeds && reply.embeds.length > 0, 'Embed must be provided');

    const embedData = reply.embeds[0].data;
    assert.ok(embedData.title.includes('MSI'), 'Embed title should include MSI');
    assert.ok(embedData.title.includes('Md. Saiful Islam'), 'Embed title should include faculty name');
    assert.ok(embedData.description.includes('msi@bracu.ac.bd'), 'Embed description should include email');
    assert.strictEqual(embedData.fields.length, 2, 'Should have 2 fields for the 2 slots');
    assert.ok(embedData.fields[0].name.includes('SUNDAY'));
    assert.ok(embedData.fields[0].value.includes('14:00 - 15:30'));
    assert.ok(embedData.fields[0].value.includes('UB0821'));
    assert.ok(embedData.fields[0].value.includes('https://meet.google.com/msi-sunday'));
    assert.ok(embedData.footer.text.includes('Asia/Dhaka (+06:00)'));
  });

  await itAsync('handleConsultationModalSubmit returns ephemeral error if initial not found', async () => {
    const interaction = createMockModalInteraction('faculty_consultation_modal', { faculty_initial: 'UNKNOWN_INITIAL' });
    await handleConsultationModalSubmit(interaction, db);
    const reply = interaction.getReply();
    assert.ok(reply, 'Reply must be sent');
    assert.strictEqual(reply.ephemeral, true, 'Error message must be strictly ephemeral');
    assert.ok(reply.content.includes('No consultation hours found'));
    assert.ok(reply.content.includes('UNKNOWN_INITIAL'));
  });

  await itAsync('handleInteraction routes /consultation and modal submission correctly', async () => {
    // 1. Slash command router
    const chatInter = createMockChatInteraction('consultation');
    await handleInteraction(chatInter, db);
    assert.ok(chatInter.getModal(), 'Router should open consultation modal');

    // 2. Modal submission router
    const modalInter = createMockModalInteraction('faculty_consultation_modal', { faculty_initial: 'msi' });
    await handleInteraction(modalInter, db);
    assert.ok(modalInter.getReply().embeds, 'Router should process modal submission and return embed');
  });

  // --- TEST GROUP 3: Web Endpoints (GET and POST /api/consultations) ---
  console.log('\n--- TEST GROUP 3: Web API Endpoints (GET and POST /api/consultations) ---');

  const app = createServer();
  const server = app.listen(0);

  await itAsync('POST /api/consultations rejects request missing required fields', async () => {
    const res = await request(server, '/api/consultations', 'POST', {
      faculty_initial: '',
      day_of_week: 'MONDAY'
    });
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.success, false);
  });

  await itAsync('POST /api/consultations creates new consultation slot', async () => {
    const res = await request(server, '/api/consultations', 'POST', {
      faculty_initial: 'tsm',
      faculty_name: 'Tanzim Sadman',
      day_of_week: 'MONDAY',
      start_time: '11:00',
      end_time: '12:30',
      room: 'UB0501',
      contact_email: 'tsm@bracu.ac.bd',
      consultation_link: 'https://meet.google.com/tsm-consult'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.faculty_initial, 'TSM');
    assert.strictEqual(res.body.data.day_of_week, 'MONDAY');
    assert.strictEqual(res.body.data.room, 'UB0501');
  });

  await itAsync('POST /api/consultations upserts existing slot when same initial, day, and start time provided', async () => {
    const res = await request(server, '/api/consultations', 'POST', {
      faculty_initial: 'TSM',
      faculty_name: 'Tanzim Sadman (Updated)',
      day_of_week: 'MONDAY',
      start_time: '11:00',
      end_time: '13:00',
      room: 'UB0502-UPDATED'
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.strictEqual(res.body.data.room, 'UB0502-UPDATED');
    assert.strictEqual(res.body.data.end_time, '13:00');

    // Confirm only 1 slot exists for TSM Monday 11:00
    const count = db.prepare("SELECT count(*) as c FROM faculty_consultations WHERE faculty_initial = 'TSM' AND day_of_week = 'MONDAY' AND start_time = '11:00'").get().c;
    assert.strictEqual(count, 1, 'Should have updated existing slot without duplicating');
  });

  await itAsync('GET /api/consultations?initial=tsm returns matched slots case-insensitively', async () => {
    const res = await request(server, '/api/consultations?initial=tsm', 'GET');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.count >= 1);
    assert.strictEqual(res.body.data[0].faculty_initial, 'TSM');
    assert.strictEqual(res.body.data[0].room, 'UB0502-UPDATED');
  });

  await itAsync('GET /api/consultations returns all consultations', async () => {
    const res = await request(server, '/api/consultations', 'GET');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.success, true);
    assert.ok(res.body.count >= 3); // 2 MSI slots + 1 TSM slot
  });

  await itAsync('DELETE /api/consultations/:id deletes consultation slot', async () => {
    const tsmSlot = db.prepare("SELECT id FROM faculty_consultations WHERE faculty_initial = 'TSM' LIMIT 1").get();
    assert.ok(tsmSlot);

    const delRes = await request(server, `/api/consultations/${tsmSlot.id}`, 'DELETE');
    assert.strictEqual(delRes.status, 200);
    assert.strictEqual(delRes.body.success, true);

    const check = db.prepare('SELECT id FROM faculty_consultations WHERE id = ?').get(tsmSlot.id);
    assert.strictEqual(check, undefined, 'Slot should be deleted');
  });

  // --- TEST GROUP 4: Strict Architectural Constraints (No Background Reminders) ---
  console.log('\n--- TEST GROUP 4: Strict Architectural Constraints (No Background Notifications) ---');

  it('Consultations are strictly isolated from routine_slots, events, and notification_logs', () => {
    const routineCountBefore = db.prepare('SELECT count(*) as c FROM routine_slots').get().c;
    const eventCountBefore = db.prepare('SELECT count(*) as c FROM events').get().c;
    const logCountBefore = db.prepare('SELECT count(*) as c FROM notification_logs').get().c;

    db.prepare(`
      INSERT INTO faculty_consultations (
        faculty_initial, faculty_name, day_of_week, start_time, end_time, room
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run('TESTFAC', 'Test Faculty', 'FRIDAY', '10:00', '11:00', 'UB0101');

    const routineCountAfter = db.prepare('SELECT count(*) as c FROM routine_slots').get().c;
    const eventCountAfter = db.prepare('SELECT count(*) as c FROM events').get().c;
    const logCountAfter = db.prepare('SELECT count(*) as c FROM notification_logs').get().c;

    assert.strictEqual(routineCountAfter, routineCountBefore, 'routine_slots must NEVER receive consultation records');
    assert.strictEqual(eventCountAfter, eventCountBefore, 'events table must NEVER receive consultation records');
    assert.strictEqual(logCountAfter, logCountBefore, 'notification_logs must NEVER receive consultation records');
  });

  await itAsync('src/reminder-engine.js does not query or reference faculty_consultations', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const reminderEngineCode = fs.readFileSync(path.resolve('src', 'reminder-engine.js'), 'utf-8');
    assert.strictEqual(
      reminderEngineCode.includes('faculty_consultations'),
      false,
      'reminder-engine.js must NOT reference or query faculty_consultations'
    );
  });

  // Clean test data & close server
  db.prepare("DELETE FROM faculty_consultations WHERE faculty_initial IN ('MSI', 'TSM', 'TESTFAC')").run();
  server.close();

  console.log('\n====================================================');
  console.log(`  CONSULTATION TEST RESULTS: ${passed}/${passed + failed} PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[!] Test suite crashed:', err);
  process.exit(1);
});
