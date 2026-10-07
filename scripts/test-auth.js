import assert from 'assert';
import http from 'http';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { createServer } from '../src/server.js';
import { handleLinkCommand, handleLoginCommand, handleTaskButton, ensureAuthCodesTable } from '../src/commands/handlers.js';
import { slashCommands } from '../src/commands/definitions.js';

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

function parseCookies(res) {
  const setCookie = res.headers['set-cookie'];
  if (!setCookie) return {};
  const cookies = {};
  for (const c of setCookie) {
    const parts = c.split(';')[0].split('=');
    cookies[parts[0].trim()] = parts.slice(1).join('=').trim();
  }
  return cookies;
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
        let parsedBody = data;
        try {
          parsedBody = JSON.parse(data);
        } catch {}
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: parsedBody
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

async function runTestSuite() {
  console.log('====================================================');
  console.log('  TESTING DISCORD CODE AUTHENTICATION & MULTI-TENANCY');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();
  const app = createServer();
  const server = app.listen(0);
  await new Promise(r => server.once('listening', r));

  try {
    // --- TEST GROUP 1: Database Schema & Migration Verification ---
    console.log('--- TEST GROUP 1: Database Schema & Migration ---');

    it('users table has username and discord_id columns', () => {
      const cols = db.prepare("PRAGMA table_info('users')").all().map(c => c.name);
      assert.ok(cols.includes('username'), 'users table must have username column');
      assert.ok(cols.includes('discord_user_id'), 'users table must have discord_user_id column');
      assert.ok(cols.includes('discord_id'), 'users table must have discord_id column');
    });

    it('auth_codes table exists with correct schema', () => {
      const cols = db.prepare("PRAGMA table_info('auth_codes')").all().map(c => c.name);
      assert.ok(cols.includes('id'), 'has id');
      assert.ok(cols.includes('user_id'), 'has user_id');
      assert.ok(cols.includes('code'), 'has code');
      assert.ok(cols.includes('expires_at'), 'has expires_at');
      assert.ok(cols.includes('used'), 'has used');
    });

    it('sessions table exists with correct schema', () => {
      const cols = db.prepare("PRAGMA table_info('sessions')").all().map(c => c.name);
      assert.ok(cols.includes('id'), 'has id');
      assert.ok(cols.includes('user_id'), 'has user_id');
      assert.ok(cols.includes('token'), 'has token');
      assert.ok(cols.includes('expires_at'), 'has expires_at');
    });

    // --- TEST GROUP 2: Discord /login and /link Command Passkey Generation ---
    console.log('\n--- TEST GROUP 2: Discord /login and /link Command Passkey Generation ---');

    it('slashCommands registers /login and /link with matching descriptions', () => {
      const loginDef = slashCommands.find(c => c.name === 'login');
      const linkDef = slashCommands.find(c => c.name === 'link');
      assert.ok(loginDef, 'Must register /login command');
      assert.ok(linkDef, 'Must register /link command');
      assert.strictEqual(loginDef.description, 'Get your one-time passkey and link to access your academic web dashboard.');
      assert.strictEqual(linkDef.description, 'Get your one-time passkey and link to access your academic web dashboard.');
    });

    it('ensureAuthCodesTable executes defensive DDL successfully', () => {
      ensureAuthCodesTable(db);
      const cols = db.prepare("PRAGMA table_info('auth_codes')").all().map(c => c.name);
      assert.ok(cols.includes('discord_id'), 'auth_codes must have discord_id');
      assert.ok(cols.includes('code'), 'auth_codes must have code');
      assert.ok(cols.includes('expires_at'), 'auth_codes must have expires_at');
      assert.ok(cols.includes('used'), 'auth_codes must have used');
    });

    const testDiscordUser1 = { id: '1328051283080380559', username: 'TestStudent1' };
    let loginReply1 = null;

    await itAsync('/login generates a 6-character passkey in auth_codes table valid for 10 minutes', async () => {
      const mockInteraction = {
        user: testDiscordUser1,
        reply: (p) => { loginReply1 = p; }
      };

      await handleLoginCommand(mockInteraction, db);
      assert.ok(loginReply1, 'Reply must be captured');
      assert.strictEqual(loginReply1.ephemeral, true, 'Reply must be ephemeral');

      const embed = loginReply1.embeds[0];
      assert.ok(embed, 'Must include rich embed');
      assert.ok(embed.data.title.includes('Login Passkey'), 'Embed title mentions passkey');
      assert.ok(embed.data.description.includes('10 minutes'), 'Embed description mentions 10 minutes');

      const passkeyField = embed.data.fields.find(f => f.name.includes('Passkey'));
      assert.ok(passkeyField, 'Must have passkey field');
      const passkeyMatch = passkeyField.value.match(/```([A-F0-9]{6})```/);
      assert.ok(passkeyMatch, 'Passkey must be 6 uppercase hex characters in code block');

      const passkey = passkeyMatch[1];
      const codeRow = db.prepare('SELECT * FROM auth_codes WHERE code = ?').get(passkey);
      assert.ok(codeRow, 'Passkey must exist in auth_codes table');
      assert.strictEqual(codeRow.used, 0, 'Passkey must be unused');
      assert.strictEqual(codeRow.discord_id, testDiscordUser1.id, 'Passkey must record discord_id');

      // Verify expiration is ~10 minutes from now
      const expiryMs = new Date(codeRow.expires_at).getTime() - Date.now();
      assert.ok(expiryMs > 8 * 60 * 1000 && expiryMs <= 10.5 * 60 * 1000, `Expires at ~10 mins (got ${Math.round(expiryMs / 1000)}s)`);

      // Verify direct link and login button
      const loginUrlField = embed.data.fields.find(f => f.name.includes('Web Login Portal'));
      assert.ok(loginUrlField && loginUrlField.value.includes('/login'), 'Field includes login link');
      const button = loginReply1.components[0].components[0];
      assert.ok(button.data.url.endsWith('/login'), 'Button links to /login');
    });

    await itAsync('/link is an alias mapped to handleLoginCommand for backward compatibility', async () => {
      assert.strictEqual(handleLinkCommand, handleLoginCommand, 'handleLinkCommand must be mapped to handleLoginCommand');
    });

    await itAsync('Subsequent /login invalidates prior unused passkey for that user', async () => {
      const oldCode = db.prepare('SELECT * FROM auth_codes WHERE discord_id = ? AND used = 0').get(testDiscordUser1.id);
      assert.ok(oldCode, 'Prior passkey exists');

      let loginReply2 = null;
      const mockInteraction2 = {
        user: testDiscordUser1,
        reply: (p) => { loginReply2 = p; }
      };
      await handleLoginCommand(mockInteraction2, db);

      const oldCodeAfter = db.prepare('SELECT * FROM auth_codes WHERE id = ?').get(oldCode.id);
      assert.strictEqual(oldCodeAfter.used, 1, 'Prior code must be invalidated (marked used = 1)');

      const activeCodes = db.prepare('SELECT * FROM auth_codes WHERE discord_id = ? AND used = 0').all(testDiscordUser1.id);
      assert.strictEqual(activeCodes.length, 1, 'Exactly one active unused code exists');
    });

    // --- TEST GROUP 3: Web Login Landing Page (GET /login) ---
    console.log('\n--- TEST GROUP 3: Web Login Landing Page (GET /login) ---');

    await itAsync('GET /login returns 200 with HTML containing login interface', async () => {
      const res = await request(server, '/login');
      assert.strictEqual(res.status, 200);
      assert.ok(typeof res.body === 'string', 'Body must be HTML string');
      assert.ok(res.body.includes('FRIDAY'), 'Contains FRIDAY branding');
      assert.ok(res.body.includes('Passkey'), 'Contains passkey input');
      assert.ok(res.body.includes('/link'), 'Mentions /link instructions');
    });

    // --- TEST GROUP 4: Authentication API (POST /api/auth/login) ---
    console.log('\n--- TEST GROUP 4: Authentication API (POST /api/auth/login) ---');

    await itAsync('POST /api/auth/login rejects empty passkey', async () => {
      const res = await request(server, '/api/auth/login', 'POST', { code: '' });
      assert.strictEqual(res.status, 400);
      assert.strictEqual(res.body.success, false);
    });

    await itAsync('POST /api/auth/login rejects invalid passkey', async () => {
      const res = await request(server, '/api/auth/login', 'POST', { code: 'INVALID' });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('Invalid or expired'));
    });

    await itAsync('POST /api/auth/login rejects expired passkey', async () => {
      const expiredCode = 'EXP123';
      db.prepare(`
        INSERT INTO auth_codes (user_id, code, expires_at, used)
        VALUES (1, ?, datetime('now', '-10 minutes'), 0)
      `).run(expiredCode);

      const res = await request(server, '/api/auth/login', 'POST', { code: expiredCode });
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.success, false);
    });

    let user1Cookie = '';
    let lastUsedCode = null;
    await itAsync('POST /api/auth/login accepts valid passkey, marks used, and returns session cookie', async () => {
      const activeCode = db.prepare("SELECT * FROM auth_codes WHERE user_id = 1 AND used = 0 AND code != 'EXP123'").get();
      assert.ok(activeCode, 'Active code found');
      lastUsedCode = activeCode;

      const res = await request(server, '/api/auth/login', 'POST', { code: activeCode.code });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.user.id, 1);

      const cookies = parseCookies(res);
      assert.ok(cookies.friday_session, 'Response must set friday_session cookie');
      user1Cookie = `friday_session=${cookies.friday_session}`;

      // Verify code marked used
      const usedRow = db.prepare('SELECT used FROM auth_codes WHERE id = ?').get(activeCode.id);
      assert.strictEqual(usedRow.used, 1, 'Code must now be marked used');

      // Verify session exists in DB
      const sessionRow = db.prepare('SELECT * FROM sessions WHERE token = ?').get(cookies.friday_session);
      assert.ok(sessionRow, 'Session must exist in sessions table');
      assert.strictEqual(sessionRow.user_id, 1, 'Session user_id must be 1');
    });

    await itAsync('Replay attack prevented: used passkey cannot be used again', async () => {
      assert.ok(lastUsedCode, 'lastUsedCode must be set');
      const usedCodeRow = db.prepare('SELECT * FROM auth_codes WHERE id = ?').get(lastUsedCode.id);
      assert.strictEqual(usedCodeRow.used, 1, 'Code must be marked used in DB');

      const res = await request(server, '/api/auth/login', 'POST', { code: lastUsedCode.code });
      assert.strictEqual(res.status, 401, 'Reusing code must return 401');
      assert.strictEqual(res.body.success, false);
    });

    // --- TEST GROUP 5: Session Verification (GET /api/auth/me) & Auto-Redirect ---
    console.log('\n--- TEST GROUP 5: Session Verification & Web Route Protection ---');

    await itAsync('GET /api/auth/me without cookie returns 401', async () => {
      const res = await request(server, '/api/auth/me');
      assert.strictEqual(res.status, 401);
      assert.strictEqual(res.body.authenticated, false);
    });

    await itAsync('GET /api/auth/me with valid session cookie returns authenticated user info', async () => {
      const res = await request(server, '/api/auth/me', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.authenticated, true);
      assert.strictEqual(res.body.user.id, 1);
    });

    await itAsync('GET / without session cookie redirects unauthenticated user to /login (302 Found)', async () => {
      const res = await request(server, '/');
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/login');
    });

    await itAsync('GET / with valid session cookie returns 200 with dashboard HTML', async () => {
      const res = await request(server, '/', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 200);
      assert.ok(typeof res.body === 'string', 'Body must be HTML string');
      assert.ok(res.body.includes('FRIDAY'), 'Contains FRIDAY branding');
    });

    await itAsync('GET /login with active session cookie redirects to / (302 Found)', async () => {
      const res = await request(server, '/login', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/');
    });

    // --- TEST GROUP 6: Strict Multi-Tenant Isolation ---
    console.log('\n--- TEST GROUP 6: Strict Multi-Tenant Isolation ---');

    // Setup User #2
    const testDiscordUser2 = { id: '222222222222222222', username: 'SecondStudent' };
    let user2Cookie = '';

    await itAsync('Register and authenticate User #2', async () => {
      const mockInteractionU2 = {
        user: testDiscordUser2,
        reply: () => {}
      };
      await handleLinkCommand(mockInteractionU2, db);
      const u2 = db.prepare('SELECT * FROM users WHERE discord_user_id = ?').get(testDiscordUser2.id);
      assert.ok(u2, 'User 2 exists');
      assert.strictEqual(u2.id, 2);

      const u2Code = db.prepare('SELECT * FROM auth_codes WHERE user_id = 2 AND used = 0').get();
      assert.ok(u2Code, 'User 2 code exists');

      const loginRes = await request(server, '/api/auth/login', 'POST', { code: u2Code.code });
      assert.strictEqual(loginRes.status, 200);
      assert.strictEqual(loginRes.body.user.id, 2);

      const cookies = parseCookies(loginRes);
      user2Cookie = `friday_session=${cookies.friday_session}`;
    });

    // Seed distinct data for User #2
    db.prepare(`
      INSERT INTO courses (id, user_id, code, name, section, faculty, room, credits)
      VALUES (201, 2, 'CSE470', 'Software Engineering', '01', 'SAR', 'UB0301', 3.0)
    `).run();

    db.prepare(`
      INSERT INTO events (id, user_id, course_id, type, title, start_time, end_time, room, is_custom)
      VALUES (901, 2, 201, 'ASSIGNMENT', 'User 2 Private Essay', '2026-11-15T18:00:00+06:00', '2026-11-15T18:00:00+06:00', 'Online', 1)
    `).run();

    await itAsync('Tenant Isolation: User #1 cannot view User #2 courses via ?user_id=2 override', async () => {
      // User 1 calls GET /api/courses?user_id=2
      const res = await request(server, '/api/courses?user_id=2', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 200);
      const codes = res.body.data.map(c => c.code);
      assert.ok(!codes.includes('CSE470'), 'User 1 must NOT see User 2 course CSE470');
      assert.ok(codes.includes('CSE330'), 'User 1 sees their own course CSE330');
    });

    await itAsync('Tenant Isolation: User #1 cannot view User #2 events via x-user-id header', async () => {
      const res = await request(server, '/api/events', 'GET', null, {
        Cookie: user1Cookie,
        'X-User-Id': '2'
      });
      assert.strictEqual(res.status, 200);
      const titles = res.body.data.map(e => e.title);
      assert.ok(!titles.includes('User 2 Private Essay'), 'User 1 must NOT see User 2 private events');
    });

    await itAsync('Tenant Isolation: User #1 cannot edit User #2 custom event (returns 403 Forbidden)', async () => {
      const res = await request(server, '/api/events/901', 'PUT', {
        title: 'Hacked by User 1',
        type: 'ASSIGNMENT',
        start_time: '2026-11-15T18:00:00+06:00'
      }, { Cookie: user1Cookie });

      assert.strictEqual(res.status, 403, 'Must return 403 Forbidden');
      assert.strictEqual(res.body.success, false);
      assert.ok(res.body.error.includes('another student'));

      // Verify DB was NOT modified
      const ev = db.prepare('SELECT title FROM events WHERE id = 901').get();
      assert.strictEqual(ev.title, 'User 2 Private Essay', 'Event title must remain unchanged');
    });

    await itAsync('Tenant Isolation: User #1 cannot delete User #2 custom event (returns 403 Forbidden)', async () => {
      const res = await request(server, '/api/events/901', 'DELETE', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 403, 'Must return 403 Forbidden');
      assert.strictEqual(res.body.success, false);

      // Verify event was NOT deleted
      const ev = db.prepare('SELECT id FROM events WHERE id = 901').get();
      assert.ok(ev, 'Event must still exist');
    });

    await itAsync('Tenant Isolation: User #1 cannot trigger test alert for User #2 event', async () => {
      const res = await request(server, '/api/events/901/test-alert', 'POST', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 403, 'Must return 403 Forbidden');
      assert.strictEqual(res.body.success, false);
    });

    await itAsync('Tenant Isolation: User #2 can edit their own custom event', async () => {
      const res = await request(server, '/api/events/901', 'PUT', {
        title: 'User 2 Legitimate Update',
        type: 'ASSIGNMENT',
        start_time: '2026-11-15T18:00:00+06:00'
      }, { Cookie: user2Cookie });

      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);
      assert.strictEqual(res.body.data.title, 'User 2 Legitimate Update');
    });

    await itAsync('Tenant Isolation: User #1 cannot inject event under User #2 via POST /api/events with body { user_id: 2 }', async () => {
      const res = await request(server, '/api/events', 'POST', {
        user_id: 2,
        title: 'Tampered Event by User 1',
        type: 'ASSIGNMENT',
        start_time: '2026-11-20T10:00:00+06:00'
      }, { Cookie: user1Cookie });

      assert.strictEqual(res.status, 200);
      const createdId = res.body.data.id;
      const createdEv = db.prepare('SELECT user_id FROM events WHERE id = ?').get(createdId);
      assert.strictEqual(createdEv.user_id, 1, 'Event must be bound to authenticated User #1, not spoofed User #2');
    });

    await itAsync('Tenant Isolation: User #1 only sees their own profile when calling GET /api/users', async () => {
      const res = await request(server, '/api/users', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.data.length, 1);
      assert.strictEqual(res.body.data[0].id, 1);
    });

    await itAsync('Tenant Isolation: Discord Bot - User #1 cannot complete User #2 task via button', async () => {
      let replyCaptured = null;
      const mockInteractionUser1 = {
        customId: 'complete_task_901',
        user: testDiscordUser1,
        reply: async (p) => { replyCaptured = p; return p; },
        update: () => { assert.fail('Should not update when access denied'); }
      };

      await handleTaskButton(mockInteractionUser1, db);
      assert.ok(replyCaptured, 'Access denied reply captured');
      assert.ok(replyCaptured.content.includes('Access denied'), 'Must reject completion of another student task');

      // Verify event 901 was NOT deleted
      const evCheck = db.prepare('SELECT id FROM events WHERE id = 901').get();
      assert.ok(evCheck, 'User #2 event 901 must not be deleted');
    });

    // --- TEST GROUP 7: Logout Flow (POST /api/auth/logout) ---
    console.log('\n--- TEST GROUP 7: Logout Flow ---');

    await itAsync('POST /api/auth/logout invalidates session and clears cookie', async () => {
      const res = await request(server, '/api/auth/logout', 'POST', null, { Cookie: user1Cookie });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.success, true);

      // Verify session removed from DB
      const token = user1Cookie.replace('friday_session=', '');
      const sess = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      assert.strictEqual(sess, undefined, 'Session must be deleted from DB');

      // Subsequent /api/auth/me returns 401
      const meRes = await request(server, '/api/auth/me', 'GET', null, { Cookie: user1Cookie });
      assert.strictEqual(meRes.status, 401);
      assert.strictEqual(meRes.body.authenticated, false);
    });

    await itAsync('GET /logout invalidates session and redirects to /login (302 Found)', async () => {
      const res = await request(server, '/logout', 'GET', null, { Cookie: user2Cookie });
      assert.strictEqual(res.status, 302);
      assert.strictEqual(res.headers.location, '/login');

      // Verify User 2 session removed from DB
      const token = user2Cookie.replace('friday_session=', '');
      const sess = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
      assert.strictEqual(sess, undefined, 'User 2 session must be deleted from DB');

      // Subsequent /api/auth/me for User 2 returns 401
      const meRes2 = await request(server, '/api/auth/me', 'GET', null, { Cookie: user2Cookie });
      assert.strictEqual(meRes2.status, 401);
      assert.strictEqual(meRes2.body.authenticated, false);
    });

    console.log('\n====================================================');
    console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
    console.log('====================================================\n');

    server.close();
    cleanup();

    if (passed === total) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  } catch (err) {
    console.error('[FATAL] Test error:', err);
    server.close();
    cleanup();
    process.exit(1);
  }
}

runTestSuite();
