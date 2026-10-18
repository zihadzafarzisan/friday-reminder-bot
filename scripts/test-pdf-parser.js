import assert from 'assert';
import http from 'http';
import { createRequire } from 'module';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { createServer } from '../src/server.js';
import { 
  parseBracuPdf, 
  parseBracuPdfText, 
  extractPdfText, 
  normalizeTimeTo24h, 
  parseDateToIsoDhaka 
} from '../src/services/routineParser.js';
import { closeDiscordClient } from '../src/bot.js';
import { handleImportCommand } from '../src/commands/handlers.js';

const require = createRequire(import.meta.url);

let passed = 0;
let total = 0;

function it(desc, fn) {
  total++;
  try {
    fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
  }
}

async function itAsync(desc, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
  }
}

/**
 * Creates a minimal valid PDF containing text for test execution
 */
function createTestPdf(text) {
  const streamContent = 'BT /F1 12 Tf 50 700 Td (' + text.replace(/\n/g, ') Tj T* (') + ') Tj ET';
  const streamLen = Buffer.byteLength(streamContent);

  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n' +
    '4 0 obj<</Length ' + streamLen + '>>stream\n' +
    streamContent + '\n' +
    'endstream\n' +
    'endobj\n' +
    'xref\n' +
    '0 5\n' +
    '0000000000 65535 f \n' +
    '0000000009 00000 n \n' +
    '0000000052 00000 n \n' +
    '0000000101 00000 n \n' +
    '0000000201 00000 n \n' +
    'trailer<</Size 5/Root 1 0 R>>\n' +
    'startxref\n' +
    (300 + streamLen) + '\n' +
    '%%EOF'
  );
}

/**
 * Sends multipart/form-data upload request to test server
 */
function uploadMultipart(server, path, fieldName, filename, fileBuffer, headers = {}, fileMime = 'application/pdf') {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const boundary = '----WebKitFormBoundaryTest' + Math.random().toString(36).substring(2);

    const pre = Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${fieldName}"; filename="${filename}"\r\n` +
      `Content-Type: ${fileMime}\r\n\r\n`
    );
    const post = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([pre, fileBuffer, post]);

    const reqHeaders = {
      ...headers,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length
    };

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function request(server, path, method = 'GET', body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const reqHeaders = { ...headers };
    if (body && !reqHeaders['Content-Type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: reqHeaders
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', reject);
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

async function runTests() {
  console.log('====================================================');
  console.log('  TESTING ROUTINE PDF UPLOAD & PARSER FOR BRACU');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();

  console.log('--- TEST GROUP 1: Parser Module & Functions ---');
  it('routineParser exports parseBracuPdf and parseBracuPdfText', () => {
    assert.strictEqual(typeof parseBracuPdf, 'function');
    assert.strictEqual(typeof parseBracuPdfText, 'function');
  });

  it('routineParser exports extractPdfText and time/date normalizers', () => {
    assert.strictEqual(typeof extractPdfText, 'function');
    assert.strictEqual(typeof normalizeTimeTo24h, 'function');
    assert.strictEqual(typeof parseDateToIsoDhaka, 'function');
  });

  console.log('\n--- TEST GROUP 2: Routine Text Parser (Layouts & Classification) ---');
  it('parses standard BRACU advising slip block format', () => {
    const raw = `
Course: CSE110 Section: 01
Class Schedule:
Sunday 10:00 AM - 11:20 AM (Room: 09G-28C)
Tuesday 10:00 AM - 11:20 AM (Room: 09G-28C)
Midterm Exam: 2026-07-27 14:00:00 - 16:00:00 Room: 09G-28C
Final Exam: 2026-09-14 14:00:00 - 16:00:00 Room: 09G-28C
`;
    const res = parseBracuPdfText(raw);
    assert.strictEqual(res.schedules.length, 2);
    assert.strictEqual(res.schedules[0].course_code, 'CSE110');
    assert.strictEqual(res.schedules[0].day_of_week, 'SUNDAY');
    assert.strictEqual(res.schedules[0].start_time, '10:00');
    assert.strictEqual(res.schedules[0].end_time, '11:20');
    assert.strictEqual(res.schedules[0].room, '09G-28C');
    assert.strictEqual(res.schedules[0].event_type, 'CLASS');

    assert.strictEqual(res.events.length, 2);
    assert.strictEqual(res.events[0].type, 'MIDTERM');
    assert.strictEqual(res.events[0].start_time, '2026-07-27T14:00:00+06:00');
    assert.strictEqual(res.events[1].type, 'FINAL');
    assert.strictEqual(res.events[1].start_time, '2026-09-14T14:00:00+06:00');
  });

  it('classifies room ending in L as LAB and room ending in C as CLASS', () => {
    const raw = `
CSE110 01 Sunday 10:00 AM - 11:20 AM 09G-28C
CSE110L 01 Thursday 02:00 PM - 05:00 PM 12F-30L
`;
    const res = parseBracuPdfText(raw);
    assert.strictEqual(res.schedules.length, 2);
    assert.strictEqual(res.schedules[0].event_type, 'CLASS');
    assert.strictEqual(res.schedules[1].event_type, 'LAB');
  });

  it('expands BRACU day codes (ST -> Sunday & Tuesday, RA -> Thursday & Saturday)', () => {
    const raw = `
HUM101 14 ST 02:00 PM - 03:20 PM 09G-28C
CSE330L 02 RA 02:00 PM - 03:20 PM 12F-30L
`;
    const res = parseBracuPdfText(raw);
    assert.strictEqual(res.schedules.length, 4);
    assert.strictEqual(res.schedules[0].day_of_week, 'SUNDAY');
    assert.strictEqual(res.schedules[1].day_of_week, 'TUESDAY');
    assert.strictEqual(res.schedules[2].day_of_week, 'THURSDAY');
    assert.strictEqual(res.schedules[3].day_of_week, 'SATURDAY');
  });

  it('parses exams with natural language date formats (e.g. Month DD, YYYY)', () => {
    const raw = `
CSE230 05 MW 11:00 AM - 12:20 PM 08H-22C
Mid Exam: Tuesday, July 28, 2026 8:30 AM - 10:30 AM
Final Exam: Tuesday, September 15, 2026 8:30 AM - 10:30 AM
`;
    const res = parseBracuPdfText(raw);
    assert.strictEqual(res.events.length, 2);
    assert.strictEqual(res.events[0].type, 'MIDTERM');
    assert.strictEqual(res.events[0].start_time, '2026-07-28T08:30:00+06:00');
    assert.strictEqual(res.events[0].end_time, '2026-07-28T10:30:00+06:00');
    assert.strictEqual(res.events[1].type, 'FINAL');
    assert.strictEqual(res.events[1].start_time, '2026-09-15T08:30:00+06:00');
  });

  console.log('\n--- TEST GROUP 3: Binary PDF Ingestion (parseBracuPdf) ---');
  await itAsync('extracts and parses routine from binary PDF buffer', async () => {
    const pdfText = 'CSE110 01 Sunday 10:00 AM - 11:20 AM 09G-28C\nMid Exam: 2026-07-27 14:00 - 16:00';
    const pdfBuf = createTestPdf(pdfText);

    const res = await parseBracuPdf(pdfBuf);
    assert.ok(res.schedules.length >= 1);
    assert.strictEqual(res.schedules[0].course_code, 'CSE110');
    assert.strictEqual(res.schedules[0].day_of_week, 'SUNDAY');
    assert.strictEqual(res.schedules[0].room, '09G-28C');
  });

  console.log('\n--- TEST GROUP 4: Database Schema (class_schedules table) ---');
  it('class_schedules table exists with correct columns and user foreign key', () => {
    const columns = db.prepare("PRAGMA table_info('class_schedules')").all();
    const colNames = columns.map(c => c.name);
    assert.ok(colNames.includes('id'));
    assert.ok(colNames.includes('user_id'));
    assert.ok(colNames.includes('course_code'));
    assert.ok(colNames.includes('section'));
    assert.ok(colNames.includes('day_of_week'));
    assert.ok(colNames.includes('start_time'));
    assert.ok(colNames.includes('end_time'));
    assert.ok(colNames.includes('room'));
    assert.ok(colNames.includes('event_type'));
  });

  it('class_schedules table has indexes for user_id and day_of_week', () => {
    const indexes = db.prepare("PRAGMA index_list('class_schedules')").all();
    const idxNames = indexes.map(i => i.name);
    assert.ok(idxNames.includes('idx_class_schedules_user'));
    assert.ok(idxNames.includes('idx_class_schedules_day'));
  });

  console.log('\n--- TEST GROUP 5: Web API Endpoint (POST /api/schedule/upload-pdf) ---');
  const app = createServer();
  const server = http.createServer(app);
  await new Promise(res => server.listen(0, '127.0.0.1', res));

  // Create session for User #1
  const sessionToken1 = 'test_session_user_1';
  db.prepare(`
    INSERT OR REPLACE INTO sessions (user_id, token, expires_at)
    VALUES (1, ?, datetime('now', '+1 day'))
  `).run(sessionToken1);
  const cookieHeader1 = { Cookie: `friday_session=${sessionToken1}` };

  await itAsync('POST /api/schedule/upload-pdf rejects unauthenticated request with 401 JSON', async () => {
    const dummyPdf = createTestPdf('Test');
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'routine', 'routine.pdf', dummyPdf);
    assert.strictEqual(res.status, 401);
    assert.strictEqual(res.json?.error, 'Unauthorized');
    assert.ok(!res.headers?.location, 'Must not issue redirect');
    assert.ok(res.headers['content-type']?.includes('application/json'), 'Must return JSON');
  });

  await itAsync('POST /api/schedule/upload-pdf rejects request without file with 400', async () => {
    const res = await request(server, '/api/schedule/upload-pdf', 'POST', {}, cookieHeader1);
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json?.success, false);
  });

  await itAsync('POST /api/schedule/upload-pdf rejects non-PDF file with 400', async () => {
    const textBuf = Buffer.from('Sample plain text data');
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'routine', 'routine.txt', textBuf, cookieHeader1, 'text/plain');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.json?.success, false);
    assert.ok(res.json?.error?.includes('not a valid PDF'));
  });

  await itAsync('POST /api/schedule/upload-pdf ingests valid PDF with fieldname "routine"', async () => {
    const routineText = `
HUM101 14 Sunday, Tuesday 02:00 PM - 03:20 PM 09G-28C
Mid Exam: 2026-07-27 14:00 - 16:00
Final Exam: 2026-09-14 14:00 - 16:00

CSE330L 02 Thursday 02:00 PM - 05:00 PM 12F-30L
`;
    const pdfBuf = createTestPdf(routineText);
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'routine', 'my_routine.pdf', pdfBuf, cookieHeader1);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json?.success, true);
    assert.strictEqual(res.json?.user_id, 1);
    assert.strictEqual(res.json?.schedules_count, 3);
    assert.strictEqual(res.json?.events_count, 2);

    // Verify class_schedules table
    const schedules = db.prepare('SELECT * FROM class_schedules WHERE user_id = 1 ORDER BY day_of_week').all();
    assert.strictEqual(schedules.length, 3);
    const labSlot = schedules.find(s => s.course_code === 'CSE330L');
    assert.ok(labSlot);
    assert.strictEqual(labSlot.event_type, 'LAB');
    assert.strictEqual(labSlot.room, '12F-30L');

    // Verify courses table
    const courses = db.prepare('SELECT * FROM courses WHERE user_id = 1').all();
    assert.strictEqual(courses.length, 2);

    // Verify routine_slots table
    const routineSlots = db.prepare('SELECT * FROM routine_slots WHERE user_id = 1').all();
    assert.strictEqual(routineSlots.length, 3);

    // Verify events table
    const events = db.prepare('SELECT * FROM events WHERE user_id = 1 AND is_custom = 0').all();
    assert.strictEqual(events.length, 2);
  });

  await itAsync('GET /api/schedule returns user class_schedules', async () => {
    const res = await request(server, '/api/schedule', 'GET', null, cookieHeader1);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json?.success, true);
    assert.strictEqual(res.json?.count, 3);
    assert.strictEqual(res.json?.schedules.length, 3);
  });

  await itAsync('POST /api/schedule/upload-pdf accepts upload with fieldname "file"', async () => {
    const routineText = `
HUM101 14 Sunday, Tuesday 02:00 PM - 03:20 PM 09G-28C
Mid Exam: 2026-07-27 14:00 - 16:00
Final Exam: 2026-09-14 14:00 - 16:00

CSE330L 02 Thursday 02:00 PM - 05:00 PM 12F-30L
`;
    const pdfBuf = createTestPdf(routineText);
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'file', 'student_routine.pdf', pdfBuf, cookieHeader1);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json?.success, true);
    assert.strictEqual(res.json?.user_id, 1);
    assert.strictEqual(res.json?.schedules_count, 3);
    assert.strictEqual(res.json?.count, 3);
  });

  console.log('\n--- TEST GROUP 6: Strict Multi-Tenant Isolation ---');
  // Register User #2
  db.prepare(`
    INSERT OR REPLACE INTO users (id, discord_user_id, discord_id, username, pairing_code)
    VALUES (2, '222222222222222222', '222222222222222222', 'Student2', 'BRC-USER2')
  `).run();

  const sessionToken2 = 'test_session_user_2';
  db.prepare(`
    INSERT OR REPLACE INTO sessions (user_id, token, expires_at)
    VALUES (2, ?, datetime('now', '+1 day'))
  `).run(sessionToken2);
  const cookieHeader2 = { Cookie: `friday_session=${sessionToken2}` };

  await itAsync('User #2 uploads PDF without corrupting or accessing User #1 schedule', async () => {
    const u2RoutineText = `
MAT216 05 ST 08:00 AM - 09:20 AM 09G-28C
Mid Exam: 2026-07-29 11:00 - 13:00
Final Exam: 2026-09-16 11:00 - 13:00
`;
    const pdfBuf = createTestPdf(u2RoutineText);
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'routine', 'u2_routine.pdf', pdfBuf, cookieHeader2);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json?.user_id, 2);

    // User #1 class_schedules should still be 3
    const u1Schedules = db.prepare('SELECT count(*) as c FROM class_schedules WHERE user_id = 1').get().c;
    assert.strictEqual(u1Schedules, 3);

    // User #2 class_schedules should be 2
    const u2Schedules = db.prepare('SELECT count(*) as c FROM class_schedules WHERE user_id = 2').get().c;
    assert.strictEqual(u2Schedules, 2);

    // GET /api/schedule with User #2 session returns only User #2 schedules
    const u2Get = await request(server, '/api/schedule', 'GET', null, cookieHeader2);
    assert.strictEqual(u2Get.json?.user_id, 2);
    assert.strictEqual(u2Get.json?.count, 2);
    assert.strictEqual(u2Get.json?.schedules[0].course_code, 'MAT216');
  });

  console.log('\n--- TEST GROUP 7: Discord /import Magic Byte Detection ---');
  const mockInter = {
    user: { id: '1328051283080380559', tag: 'Student1' },
    options: {
      getAttachment: () => ({
        name: 'advising_slip_raw', // NO .pdf extension
        contentType: 'application/octet-stream', // Discord binary stream MIME
        content: createTestPdf('CSE110 01 Sunday 10:00 AM - 11:20 AM 09G-28C\nMid Exam: 2026-07-27 14:00 - 16:00')
      })
    },
    reply: function(payload) {
      this._reply = payload;
      return Promise.resolve(payload);
    }
  };

  await itAsync('handleImportCommand detects PDF by magic bytes %PDF even with octet-stream and no .pdf extension', async () => {
    await handleImportCommand(mockInter, db);
    assert.ok(mockInter._reply);
    assert.strictEqual(mockInter._reply.ephemeral, true);
    assert.ok(mockInter._reply.embeds && mockInter._reply.embeds.length > 0);
    const embed = mockInter._reply.embeds[0].data;
    assert.ok(embed.title.includes('Routine Imported Successfully'));
    assert.ok(embed.description.includes('1'));
  });

  const mockUnsupportedInter = {
    user: { id: '1328051283080380559', tag: 'Student1' },
    options: {
      getAttachment: () => ({
        name: 'photo.png',
        contentType: 'image/png',
        content: Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
      })
    },
    reply: function(payload) {
      this._reply = payload;
      return Promise.resolve(payload);
    }
  };

  await itAsync('handleImportCommand rejects unsupported file formats with descriptive error', async () => {
    await handleImportCommand(mockUnsupportedInter, db);
    assert.ok(mockUnsupportedInter._reply);
    assert.strictEqual(mockUnsupportedInter._reply.ephemeral, true);
    assert.ok(mockUnsupportedInter._reply.content.includes('Unsupported file format'));
  });

  await closeDiscordClient();
  await new Promise(resolve => server.close(resolve));
  cleanup();

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

runTests().catch(err => {
  console.error('[FATAL] Test failed:', err);
  process.exit(1);
});
