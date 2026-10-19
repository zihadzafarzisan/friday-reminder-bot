import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { createServer } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'friday-inactivity-session-key-2026';

const { db, cleanup } = initTestEnvironment();

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
    throw err;
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
    throw err;
  }
}

console.log('\n====================================================');
console.log('  TESTING 15-MIN ROLLING SESSION, SIDEBAR & JET BLACK DARK MODE');
console.log('====================================================\n');

const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.js'), 'utf8');
const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');

// GROUP 1: Server Session & Rolling Inactivity (src/server.js)
console.log('--- TEST GROUP 1: Rolling Inactivity Session in src/server.js ---');

it('trust proxy is enabled', () => {
  assert.ok(/app\.set\(['"]trust proxy['"],\s*1\)/.test(serverSource));
});

it('cookieParser uses fixed secret friday-inactivity-session-key-2026', () => {
  assert.ok(serverSource.includes('friday-inactivity-session-key-2026'));
  assert.ok(/app\.use\(cookieParser\(SESSION_SECRET\)\)/.test(serverSource));
});

it('createSession sets 15-minute maxAge cookie (15 * 60 * 1000)', () => {
  assert.ok(serverSource.includes('maxAge: 15 * 60 * 1000'));
  assert.ok(/httpOnly:\s*true/.test(serverSource));
  assert.ok(/signed:\s*true/.test(serverSource));
  assert.ok(/sameSite:\s*['"]lax['"]/.test(serverSource));
  assert.ok(/path:\s*['"]\/['"]/.test(serverSource));
});

it('requireAuth reads sessionUserId from signedCookies or cookies', () => {
  assert.ok(/const sessionUserId = req\.signedCookies\?\.friday_session \|\| req\.cookies\?\.friday_session/.test(serverSource));
});

it('requireAuth returns 401 Session expired for missing session on API routes', () => {
  assert.ok(serverSource.includes("error: 'Session expired'"));
});

it('requireAuth slides session forward with refreshed 15-minute maxAge', () => {
  assert.ok(/res\.cookie\(['"]friday_session['"],\s*String\(user\.id\)/.test(serverSource));
});

it('POST /api/auth/logout clears friday_session cookie with path: /', () => {
  assert.ok(/res\.clearCookie\(['"]friday_session['"],\s*\{\s*path:\s*['"]\/['"]\s*\}\)/.test(serverSource));
});

// GROUP 2: Vertical Left Sidebar Navigation (public/index.html)
console.log('\n--- TEST GROUP 2: Vertical Left Sidebar Navigation (public/index.html) ---');

it('defines aside.nm-sidebar with exact fixed positioning, 260px width, 100vh height', () => {
  assert.ok(indexHtml.includes('aside.nm-sidebar'));
  assert.ok(/aside\.nm-sidebar[\s\S]*?position:\s*fixed/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?width:\s*260px/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?height:\s*100vh/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?display:\s*flex/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?flex-direction:\s*column/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?justify-content:\s*space-between/.test(indexHtml));
  assert.ok(/aside\.nm-sidebar[\s\S]*?z-index:\s*100/.test(indexHtml));
});

it('defines main.nm-main-content offset by margin-left: 260px and padding: 2.5rem', () => {
  assert.ok(indexHtml.includes('main.nm-main-content'));
  assert.ok(/main\.nm-main-content[\s\S]*?margin-left:\s*260px/.test(indexHtml));
  assert.ok(/main\.nm-main-content[\s\S]*?padding:\s*2\.5rem/.test(indexHtml));
  assert.ok(/main\.nm-main-content[\s\S]*?min-height:\s*100vh/.test(indexHtml));
});

it('renders Brand Header with logo badge, bot name, and user tag in sidebar', () => {
  assert.ok(indexHtml.includes('sidebar-brand'));
  assert.ok(indexHtml.includes('FRIDAY'));
  assert.ok(indexHtml.includes('sidebarUserTag'));
});

it('renders navigation links for Home, Weekly Timetable, Academic Deadlines, and Import Routine', () => {
  assert.ok(indexHtml.includes('switchNav(\'home\'') || indexHtml.includes('switchNav("home"'));
  assert.ok(indexHtml.includes('switchNav(\'timetable\'') || indexHtml.includes('switchNav("timetable"'));
  assert.ok(indexHtml.includes('switchNav(\'deadlines\'') || indexHtml.includes('switchNav("deadlines"'));
  assert.ok(indexHtml.includes('switchNav(\'import\'') || indexHtml.includes('switchNav("import"'));
});

it('renders Home view with overview stats, next upcoming class alert, and quick actions', () => {
  assert.ok(indexHtml.includes('tab-home'));
  assert.ok(indexHtml.includes('nextClassAlertCard'));
  assert.ok(indexHtml.includes('nextClassTitle'));
  assert.ok(indexHtml.includes('nextClassCountdown'));
  assert.ok(indexHtml.includes('metrics-grid'));
  assert.ok(indexHtml.includes('quick-actions-card') || indexHtml.includes('Quick Actions'));
});

it('renders Sidebar Footer with Theme Toggle and Sign Out buttons', () => {
  assert.ok(indexHtml.includes('sidebar-footer'));
  assert.ok(indexHtml.includes('themeToggleBtn'));
  assert.ok(indexHtml.includes('themeIcon'));
  assert.ok(indexHtml.includes('themeLabel'));
  assert.ok(indexHtml.includes('handleLogout'));
});

it('applies hover physics: translateX(6px), extruded shadow, blue glow SVG drop-shadow', () => {
  assert.ok(/\.nm-sidebar\s+\.nav-item:hover[\s\S]*?translateX\(6px\)/.test(indexHtml));
  assert.ok(/\.nm-sidebar\s+\.nav-item:hover[\s\S]*?box-shadow:\s*var\(--nm-shadow-out-sm\)/.test(indexHtml));
  assert.ok(/drop-shadow\(0\s+0\s+6px\s+rgba\(59,\s*130,\s*246,\s*0\.5\)\)/.test(indexHtml));
});

it('applies active physics: inset pressed shadow, accent blue color, font-weight 700', () => {
  assert.ok(/\.nm-sidebar\s+\.nav-item\.active[\s\S]*?box-shadow:\s*var\(--nm-shadow-in\)/.test(indexHtml));
  assert.ok(/\.nm-sidebar\s+\.nav-item\.active[\s\S]*?color:\s*var\(--nm-accent-blue\)/.test(indexHtml));
  assert.ok(/\.nm-sidebar\s+\.nav-item\.active[\s\S]*?font-weight:\s*700/.test(indexHtml));
});

// GROUP 3: Exact Jet Black Dark Mode (#000000)
console.log('\n--- TEST GROUP 3: Exact Jet Black Dark Mode (#000000) ---');

it('defines required Light Mode variables in :root', () => {
  assert.ok(indexHtml.includes('--nm-bg: #e2e8f0;'));
  assert.ok(indexHtml.includes('--nm-surface: #e2e8f0;'));
  assert.ok(indexHtml.includes('--nm-surface-hover: #edf2f7;'));
  assert.ok(indexHtml.includes('--nm-text-primary: #1e293b;'));
  assert.ok(indexHtml.includes('--nm-text-secondary: #64748b;'));
  assert.ok(indexHtml.includes('--nm-border: rgba(255, 255, 255, 0.7);'));
  assert.ok(indexHtml.includes('--nm-shadow-out: 8px 8px 18px #cad3df, -8px -8px 18px #ffffff;'));
  assert.ok(indexHtml.includes('--nm-shadow-out-sm: 4px 4px 10px #cad3df, -4px -4px 10px #ffffff;'));
  assert.ok(indexHtml.includes('--nm-shadow-in: inset 4px 4px 8px #cad3df, inset -4px -4px 8px #ffffff;'));
  assert.ok(indexHtml.includes('--nm-shadow-in-sm: inset 2px 2px 5px #cad3df, inset -2px -2px 5px #ffffff;'));
  assert.ok(indexHtml.includes('--nm-shadow-in-deep: inset 6px 6px 12px #cad3df, inset -6px -6px 12px #ffffff;'));
  assert.ok(indexHtml.includes('--nm-accent-blue: #3b82f6;'));
  assert.ok(indexHtml.includes('--nm-accent-amber: #f59e0b;'));
  assert.ok(indexHtml.includes('--nm-accent-green: #10b981;'));
  assert.ok(indexHtml.includes('--nm-accent-rose: #f43f5e;'));
});

it('defines Exact Jet Black Dark Mode variables in body.dark-mode', () => {
  assert.ok(indexHtml.includes('body.dark-mode'));
  assert.ok(indexHtml.includes('--nm-bg: #000000;'));
  assert.ok(indexHtml.includes('--nm-surface: #0a0a0c;'));
  assert.ok(indexHtml.includes('--nm-surface-hover: #121216;'));
  assert.ok(indexHtml.includes('--nm-text-primary: #f8fafc;'));
  assert.ok(indexHtml.includes('--nm-text-secondary: #94a3b8;'));
  assert.ok(indexHtml.includes('--nm-border: rgba(255, 255, 255, 0.06);'));
  assert.ok(indexHtml.includes('--nm-shadow-out: 8px 8px 20px rgba(0, 0, 0, 0.95), -2px -2px 10px rgba(255, 255, 255, 0.04);'));
  assert.ok(indexHtml.includes('--nm-shadow-out-sm: 4px 4px 10px rgba(0, 0, 0, 0.9), -1px -1px 6px rgba(255, 255, 255, 0.05);'));
  assert.ok(indexHtml.includes('--nm-shadow-in: inset 4px 4px 10px #000000, inset -2px -2px 6px rgba(255, 255, 255, 0.04);'));
  assert.ok(indexHtml.includes('--nm-shadow-in-sm: inset 2px 2px 5px #000000, inset -1px -1px 4px rgba(255, 255, 255, 0.03);'));
  assert.ok(indexHtml.includes('--nm-shadow-in-deep: inset 8px 8px 16px #000000, inset -3px -3px 8px rgba(255, 255, 255, 0.04);'));
  assert.ok(indexHtml.includes('--nm-accent-blue: #60a5fa;'));
  assert.ok(indexHtml.includes('--nm-accent-amber: #fbbf24;'));
  assert.ok(indexHtml.includes('--nm-accent-green: #34d399;'));
  assert.ok(indexHtml.includes('--nm-accent-rose: #fb7185;'));
});

it('handles 401 session expiration by clearing sessionStorage and redirecting to /login', () => {
  assert.ok(indexHtml.includes('sessionStorage.clear()'));
  assert.ok(indexHtml.includes("window.location.href = '/login'"));
});

it('enforces credentials: same-origin across fetch calls', () => {
  assert.ok(indexHtml.includes("credentials: 'same-origin'"));
});

// GROUP 4: Live HTTP Rolling Session Renewal Test
console.log('\n--- TEST GROUP 4: Live Server Rolling Session & sliding renewal ---');

const testPort = 3991;
const app = createServer();
const serverInstance = await new Promise((resolve) => {
  const s = app.listen(testPort, () => resolve(s));
});

function httpRequest(path, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: testPort,
      path,
      method,
      headers: { ...headers, Connection: 'close' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          data: data ? (res.headers['content-type']?.includes('application/json') ? JSON.parse(data) : data) : null
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

await itAsync('Unauthenticated API call returns 401 with { success: false, error: "Session expired" }', async () => {
  const res = await httpRequest('/api/events', 'GET', { 'x-enforce-auth': '1' });
  assert.strictEqual(res.status, 401);
  assert.strictEqual(res.data.success, false);
  assert.strictEqual(res.data.error, 'Session expired');
});

await itAsync('Unauthenticated page call redirects to /login (302)', async () => {
  const res = await httpRequest('/', 'GET', { 'x-enforce-auth': '1' });
  assert.strictEqual(res.status, 302);
  assert.strictEqual(res.headers.location, '/login');
});

await itAsync('Active authenticated request slides session cookie forward with 15-min maxAge', async () => {
  // Generate valid passkey for User #1
  const passkey = 'TEST15';
  db.prepare(`
    INSERT INTO auth_codes (user_id, discord_id, code, expires_at, used)
    VALUES (1, '1328051283080380559', ?, datetime('now', '+10 minutes'), 0)
  `).run(passkey);

  // Login via POST /api/auth/login
  const loginReq = http.request({
    hostname: '127.0.0.1',
    port: testPort,
    path: '/api/auth/login',
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });

  const loginRes = await new Promise((resolve, reject) => {
    loginReq.on('response', (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, data: JSON.parse(data) }));
    });
    loginReq.on('error', reject);
    loginReq.write(JSON.stringify({ code: passkey }));
    loginReq.end();
  });

  assert.strictEqual(loginRes.status, 200);
  assert.strictEqual(loginRes.data.success, true);
  const setCookie = loginRes.headers['set-cookie'];
  assert.ok(setCookie, 'Login must set session cookie');
  const cookieStr = Array.isArray(setCookie) ? setCookie[0] : String(setCookie);
  assert.ok(cookieStr.includes('Max-Age=900'), 'Cookie Max-Age must be 900 seconds (15 minutes)');

  // Now make authenticated API request with this cookie
  const cookieVal = cookieStr.split(';')[0];
  const apiRes = await httpRequest('/api/events', 'GET', { Cookie: cookieVal, 'x-enforce-auth': '1' });
  assert.strictEqual(apiRes.status, 200);
  assert.strictEqual(apiRes.data.success, true);

  // Verify sliding renewal re-issued cookie
  const renewedCookie = apiRes.headers['set-cookie'];
  assert.ok(renewedCookie, 'Active request must re-issue friday_session to slide expiration forward');
  const renewedStr = Array.isArray(renewedCookie) ? renewedCookie[0] : String(renewedCookie);
  assert.ok(renewedStr.includes('friday_session='), 'Must re-issue friday_session');
  assert.ok(renewedStr.includes('Max-Age=900'), 'Renewed cookie Max-Age must be 900 seconds (15 minutes)');
});

await itAsync('POST /api/auth/logout terminates session and clears cookie with path: /', async () => {
  const res = await httpRequest('/api/auth/logout', 'POST');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie);
  const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.ok(cookieStr.includes('friday_session=;'));
  assert.ok(cookieStr.includes('Path=/'));
});

// Cleanup
await new Promise(resolve => serverInstance.close(resolve));
cleanup();

console.log('\n====================================================');
console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (100%)`);
console.log('====================================================\n');
process.exit(0);
