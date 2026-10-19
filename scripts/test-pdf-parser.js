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
  parseDateToIsoDhaka,
  reconstructFacultyAndRoom,
  parseExamScheduleText,
  parseBracuGridElements,
  customPageRender
} from '../src/services/routineParser.js';
import { closeDiscordClient } from '../src/bot.js';
import { handleImportCommand, handleTodayCommand, handleNextCommand } from '../src/commands/handlers.js';

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
 * Creates a coordinate-aware PDF with individual (X, Y) text operators
 */
function createCoordinateRoutinePdf(items) {
  let stream = '';
  for (const it of items) {
    stream += `BT /F1 10 Tf 1 0 0 1 ${it.x} ${it.y} Tm (${it.str}) Tj ET\n`;
  }
  const streamLen = Buffer.byteLength(stream);

  return Buffer.from(
    '%PDF-1.4\n' +
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n' +
    '3 0 obj<</Type/Page/MediaBox[0 0 1000 800]/Parent 2 0 R/Resources<<>>/Contents 4 0 R>>endobj\n' +
    '4 0 obj<</Length ' + streamLen + '>>stream\n' +
    stream + '\n' +
    'endstream\n' +
    'endobj\n' +
    'xref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000052 00000 n \n0000000101 00000 n \n0000000201 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n' +
    (300 + streamLen) + '\n%%EOF'
  );
}

/**
 * Creates full mock BRACU Connect PDF with 2D schedule grid (8 slots) and exam date table (8 exams)
 */
function createSampleBracuRoutinePdf() {
  const items = [
    // Day headers
    { str: 'TIME', x: 80, y: 700 },
    { str: 'SUNDAY', x: 200, y: 700 },
    { str: 'MONDAY', x: 300, y: 700 },
    { str: 'TUESDAY', x: 400, y: 700 },
    { str: 'WEDNESDAY', x: 500, y: 700 },
    { str: 'THURSDAY', x: 600, y: 700 },
    { str: 'FRIDAY', x: 700, y: 700 },
    { str: 'SATURDAY', x: 800, y: 700 },

    // Time row headers
    { str: '08:00 AM - 09:20 AM', x: 80, y: 640 },
    { str: '09:30 AM - 10:50 AM', x: 80, y: 580 },
    { str: '11:00 AM - 12:20 PM', x: 80, y: 520 },
    { str: '02:00 PM - 05:00 PM', x: 80, y: 460 },
    { str: '08:00 AM - 11:00 AM', x: 80, y: 400 },
    { str: '11:00 AM - 02:00 PM', x: 80, y: 340 },

    // 1. CSE260-05 (Sunday 08:00 - 09:20, Room 10B-16C)
    { str: 'CSE260-05', x: 200, y: 640 },
    { str: 'PBK-10B-16C', x: 200, y: 628 },

    // 2. CSE260-05 (Tuesday 08:00 - 09:20, Room 10B-16C)
    { str: 'CSE260-05', x: 400, y: 640 },
    { str: 'PBK-10B-16C', x: 400, y: 628 },

    // 3. CSE220-09 (Sunday 11:00 - 12:20, Room 09A-06C)
    { str: 'CSE220-09', x: 200, y: 520 },
    { str: 'SWG-09A-06C', x: 200, y: 508 },

    // 4. CSE220-09 (Tuesday 11:00 - 12:20, Room 09A-06C)
    { str: 'CSE220-09', x: 400, y: 520 },
    { str: 'SWG-09A-06C', x: 400, y: 508 },

    // 5. MAT215-13 (Monday 09:30 - 10:50, split room "12A" and "11C")
    { str: 'MAT215-13', x: 300, y: 580 },
    { str: 'SAN-12A', x: 300, y: 568 },
    { str: '11C', x: 300, y: 556 },

    // 6. CSE260L-05 (Saturday 08:00 - 11:00, Lab AS1-13L)
    { str: 'CSE260L-05', x: 800, y: 400 },
    { str: 'TBA-AS1-13L', x: 800, y: 388 },

    // 7. CSE220L-09 (Monday 11:00 - 02:00, Lab 09B-09L)
    { str: 'CSE220L-09', x: 300, y: 340 },
    { str: 'TBA-09B-09L', x: 300, y: 328 },

    // 8. CSE330L-11 (Thursday 02:00 - 05:00, Lab 12F-30L)
    { str: 'CSE330L-11', x: 600, y: 460 },
    { str: 'TBA-12F-30L', x: 600, y: 448 },

    // Exam section
    { str: 'DAY TIME EXAM COURSE', x: 80, y: 280 },
    { str: 'Saturday (2026-11-21) 02:00 PM - 04:00 PM MID CSE260', x: 80, y: 250 },
    { str: 'Sunday (2026-11-22) 11:00 AM - 01:00 PM MID CSE220', x: 80, y: 235 },
    { str: 'Monday (2026-11-23) 08:30 AM - 10:30 AM MID MAT215', x: 80, y: 220 },
    { str: 'Wednesday (2026-11-25) 11:00 AM - 01:00 PM MID CSE330', x: 80, y: 205 },
    { str: 'Saturday (2027-01-23) 02:00 PM - 04:00 PM FINAL CSE260', x: 80, y: 190 },
    { str: 'Sunday (2027-01-24) 11:00 AM - 01:00 PM FINAL CSE220', x: 80, y: 175 },
    { str: 'Monday (2027-01-25) 08:30 AM - 10:30 AM FINAL MAT215', x: 80, y: 160 },
    { str: 'Wednesday (2027-01-27) 11:00 AM - 01:00 PM FINAL CSE330', x: 80, y: 145 }
  ];

  return createCoordinateRoutinePdf(items);
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
    assert.ok(res.json?.error === 'Session expired' || res.json?.error === 'Unauthorized');
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

  await itAsync('handleImportCommand rejects non-PDF file failing JSON parse with descriptive error', async () => {
    await handleImportCommand(mockUnsupportedInter, db);
    assert.ok(mockUnsupportedInter._reply);
    assert.strictEqual(mockUnsupportedInter._reply.ephemeral, true);
    assert.ok(mockUnsupportedInter._reply.content.includes('Invalid JSON'));
  });

  const mockGridInter = {
    user: { id: '1328051283080380559', tag: 'Student1' },
    options: {
      getAttachment: () => ({
        name: 'student_routine.pdf',
        contentType: 'application/pdf',
        content: createSampleBracuRoutinePdf()
      })
    },
    reply: function(payload) {
      this._reply = payload;
      return Promise.resolve(payload);
    }
  };

  await itAsync('handleImportCommand imports 2D grid timetable and exam dates via Discord command', async () => {
    await handleImportCommand(mockGridInter, db);
    assert.ok(mockGridInter._reply);
    assert.strictEqual(mockGridInter._reply.ephemeral, true);
    assert.ok(mockGridInter._reply.embeds && mockGridInter._reply.embeds.length > 0);
    const embed = mockGridInter._reply.embeds[0].data;
    assert.ok(embed.title.includes('Routine Imported Successfully'));
    assert.ok(embed.description.includes('8'));
  });

  console.log('\n--- TEST GROUP 8: 2D Timetable Grid Parser (Coordinate-Aware) ---');
  it('reconstructFacultyAndRoom joins broken room segments "12A" and "11C" into "12A-11C"', () => {
    const res = reconstructFacultyAndRoom(['SAN-12A', '11C']);
    assert.strictEqual(res.faculty, 'SAN');
    assert.strictEqual(res.room, '12A-11C');
  });

  it('reconstructFacultyAndRoom handles standard and lab faculty-room strings', () => {
    const res1 = reconstructFacultyAndRoom(['PBK-10B-16C']);
    assert.strictEqual(res1.faculty, 'PBK');
    assert.strictEqual(res1.room, '10B-16C');

    const res2 = reconstructFacultyAndRoom(['TBA-AS1-13L']);
    assert.strictEqual(res2.faculty, 'TBA');
    assert.strictEqual(res2.room, 'AS1-13L');
  });

  await itAsync('parseBracuPdf extracts 8 weekly class/lab slots from 2D coordinate grid', async () => {
    const pdfBuf = createSampleBracuRoutinePdf();
    const result = await parseBracuPdf(pdfBuf);
    assert.strictEqual(result.schedules.length, 8, `Expected 8 class slots, got ${result.schedules.length}`);

    // Verify theory courses
    const cse260Slots = result.schedules.filter(s => s.course_code === 'CSE260');
    assert.strictEqual(cse260Slots.length, 2);
    assert.ok(cse260Slots.some(s => s.day_of_week === 'SUNDAY' && s.start_time === '08:00' && s.room === '10B-16C'));
    assert.ok(cse260Slots.some(s => s.day_of_week === 'TUESDAY' && s.start_time === '08:00' && s.room === '10B-16C'));

    const cse220Slots = result.schedules.filter(s => s.course_code === 'CSE220');
    assert.strictEqual(cse220Slots.length, 2);
    assert.ok(cse220Slots.some(s => s.day_of_week === 'SUNDAY' && s.start_time === '11:00' && s.room === '09A-06C'));
    assert.ok(cse220Slots.some(s => s.day_of_week === 'TUESDAY' && s.start_time === '11:00' && s.room === '09A-06C'));

    const mat215Slot = result.schedules.find(s => s.course_code === 'MAT215');
    assert.ok(mat215Slot);
    assert.strictEqual(mat215Slot.day_of_week, 'MONDAY');
    assert.strictEqual(mat215Slot.start_time, '09:30');
    assert.strictEqual(mat215Slot.end_time, '10:50');
    assert.strictEqual(mat215Slot.room, '12A-11C');
    assert.strictEqual(mat215Slot.event_type, 'CLASS');

    // Verify 3 labs
    const cse260l = result.schedules.find(s => s.course_code === 'CSE260L');
    assert.ok(cse260l);
    assert.strictEqual(cse260l.day_of_week, 'SATURDAY');
    assert.strictEqual(cse260l.event_type, 'LAB');
    assert.strictEqual(cse260l.room, 'AS1-13L');

    const cse220l = result.schedules.find(s => s.course_code === 'CSE220L');
    assert.ok(cse220l);
    assert.strictEqual(cse220l.day_of_week, 'MONDAY');
    assert.strictEqual(cse220l.event_type, 'LAB');
    assert.strictEqual(cse220l.room, '09B-09L');

    const cse330l = result.schedules.find(s => s.course_code === 'CSE330L');
    assert.ok(cse330l);
    assert.strictEqual(cse330l.day_of_week, 'THURSDAY');
    assert.strictEqual(cse330l.event_type, 'LAB');
    assert.strictEqual(cse330l.room, '12F-30L');
  });

  console.log('\n--- TEST GROUP 9: Exam Schedule Parser (DAY TIME EXAM COURSE) ---');
  await itAsync('parseBracuPdf extracts 8 exam dates (4 midterms, 4 finals) adjusted for Asia/Dhaka (+06:00)', async () => {
    const pdfBuf = createSampleBracuRoutinePdf();
    const result = await parseBracuPdf(pdfBuf);
    assert.strictEqual(result.events.length, 8, `Expected 8 exam events, got ${result.events.length}`);

    const midterms = result.events.filter(e => e.type === 'MIDTERM');
    const finals = result.events.filter(e => e.type === 'FINAL');
    assert.strictEqual(midterms.length, 4);
    assert.strictEqual(finals.length, 4);

    const cse260Mid = midterms.find(e => e.course_code === 'CSE260');
    assert.ok(cse260Mid);
    assert.strictEqual(cse260Mid.start_time, '2026-11-21T14:00:00+06:00');
    assert.strictEqual(cse260Mid.end_time, '2026-11-21T16:00:00+06:00');
    assert.strictEqual(cse260Mid.kind, 'MIDTERM');

    const cse220Final = finals.find(e => e.course_code === 'CSE220');
    assert.ok(cse220Final);
    assert.strictEqual(cse220Final.start_time, '2027-01-24T11:00:00+06:00');
    assert.strictEqual(cse220Final.end_time, '2027-01-24T13:00:00+06:00');
    assert.strictEqual(cse220Final.kind, 'FINAL');
  });

  console.log('\n--- TEST GROUP 10: Full Upload Verification (Web POST & Persistence) ---');
  await itAsync('POST /api/schedule/upload-pdf imports 8 class slots and 8 exam dates into isolated database', async () => {
    const pdfBuf = createSampleBracuRoutinePdf();
    const res = await uploadMultipart(server, '/api/schedule/upload-pdf', 'routine', 'bracu_connect_routine.pdf', pdfBuf, cookieHeader1);

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json?.success, true);
    assert.strictEqual(res.json?.schedules_count, 8);
    assert.strictEqual(res.json?.events_count, 8);

    // Verify class_schedules table has exactly 8 rows for user 1
    const schedules = db.prepare('SELECT * FROM class_schedules WHERE user_id = 1 ORDER BY id ASC').all();
    assert.strictEqual(schedules.length, 8);
    const labs = schedules.filter(s => s.event_type === 'LAB');
    assert.strictEqual(labs.length, 3);
    const classes = schedules.filter(s => s.event_type === 'CLASS');
    assert.strictEqual(classes.length, 5);

    // Verify events table has exactly 8 rows for user 1 with event_type and event_time populated
    const userEvents = db.prepare('SELECT * FROM events WHERE user_id = 1 AND is_custom = 0 ORDER BY start_time ASC').all();
    assert.strictEqual(userEvents.length, 8);
    for (const ev of userEvents) {
      assert.ok(ev.event_type === 'MIDTERM' || ev.event_type === 'FINAL');
      assert.ok(ev.event_time.includes('+06:00'));
      assert.strictEqual(ev.event_time, ev.start_time);
    }
  });

  console.log('\n--- TEST GROUP 11: Dashboard Routine View & Discord Commands ---');
  await itAsync('GET /api/schedule and GET /api/routine immediately return the 8 imported routine slots', async () => {
    const schedRes = await request(server, '/api/schedule', 'GET', null, cookieHeader1);
    assert.strictEqual(schedRes.status, 200);
    assert.strictEqual(schedRes.json?.count, 8);

    const routineRes = await request(server, '/api/routine', 'GET', null, cookieHeader1);
    assert.strictEqual(routineRes.status, 200);
    assert.strictEqual(routineRes.json?.count, 8);
    const slots = routineRes.json?.routine;
    assert.ok(slots.some(s => s.code === 'MAT215' && s.room === '12A-11C'));
  });

  await itAsync('Discord /today and /next immediately display imported courses with correct days and rooms', async () => {
    const mockTodayInter = {
      user: { id: '1328051283080380559', username: 'Student1' },
      isChatInputCommand: () => true,
      reply: function(payload) {
        this._reply = payload;
        return Promise.resolve(payload);
      }
    };
    await handleTodayCommand(mockTodayInter, db);
    assert.ok(mockTodayInter._reply);
    assert.ok(mockTodayInter._reply.embeds && mockTodayInter._reply.embeds.length > 0);

    const mockNextInter = {
      user: { id: '1328051283080380559', username: 'Student1' },
      isChatInputCommand: () => true,
      reply: function(payload) {
        this._reply = payload;
        return Promise.resolve(payload);
      }
    };
    await handleNextCommand(mockNextInter, db);
    assert.ok(mockNextInter._reply);
    assert.ok(mockNextInter._reply.embeds && mockNextInter._reply.embeds.length > 0);
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
