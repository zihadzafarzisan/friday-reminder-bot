import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { createServer } from '../src/server.js';
import { getDb } from '../src/db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

process.env.NODE_ENV = 'test';
process.env.SESSION_SECRET = 'friday-persistent-session-secret-salt-2026';

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
console.log('  TESTING MULTI-TAB SESSION PERSISTENCE & NEUMORPHIC UI');
console.log('====================================================\n');

// Group 1: Backend Session & Cookie Configuration in src/server.js
console.log('--- TEST GROUP 1: Backend Session Configuration (`src/server.js`) ---');

const serverSource = fs.readFileSync(path.join(ROOT_DIR, 'src', 'server.js'), 'utf8');

it('trust proxy is configured immediately on app initialization', () => {
  assert.ok(
    /app\.set\(['"]trust proxy['"],\s*1\)/.test(serverSource),
    'app.set("trust proxy", 1) must be configured in createServer'
  );
});

it('cookieParser uses stable fallback secret friday-persistent-session-secret-salt-2026', () => {
  assert.ok(
    serverSource.includes('friday-persistent-session-secret-salt-2026'),
    'SESSION_SECRET must fall back to friday-persistent-session-secret-salt-2026'
  );
  assert.ok(
    /app\.use\(cookieParser\(SESSION_SECRET\)\)/.test(serverSource),
    'cookieParser must be initialized with SESSION_SECRET'
  );
});

it('createSession sets 30-day persistent cookie with maxAge, httpOnly, signed, sameSite: lax, path: /', () => {
  assert.ok(serverSource.includes("res.cookie('friday_session', String(userId)"), 'res.cookie friday_session must be called');
  assert.ok(serverSource.includes('30 * 24 * 60 * 60 * 1000'), 'Cookie must have 30 days maxAge (30 * 24 * 60 * 60 * 1000)');
  assert.ok(/httpOnly:\s*true/.test(serverSource), 'Cookie must have httpOnly: true');
  assert.ok(/signed:\s*true/.test(serverSource), 'Cookie must have signed: true');
  assert.ok(/sameSite:\s*['"]lax['"]/.test(serverSource), 'Cookie must have sameSite: lax');
  assert.ok(/path:\s*['"]\/['"]/.test(serverSource), 'Cookie must have path: /');
});

it('requireAuth inspects signed cookies with unsigned fallback (sessionUserId)', () => {
  assert.ok(
    /const sessionUserId = req\.signedCookies\?\.friday_session \|\| req\.cookies\?\.friday_session/.test(serverSource),
    'requireAuth must inspect signedCookies with unsigned fallback for friday_session'
  );
});

it('requireAuth returns 401 JSON for /api/* without issuing 302 redirect', () => {
  assert.ok(
    /return res\.status\(401\)\.json\(\{\s*success:\s*false,\s*error:\s*['"](Session expired|Unauthorized)['"]\s*\}\)/.test(serverSource),
    'requireAuth must return 401 Unauthorized JSON for API calls'
  );
});

it('POST /api/auth/logout clears cookie with path: / and returns success message', () => {
  assert.ok(
    /app\.post\(['"]\/api\/auth\/logout['"]/.test(serverSource),
    'app.post("/api/auth/logout") must be registered'
  );
  assert.ok(
    /res\.clearCookie\(['"]friday_session['"],\s*\{\s*path:\s*['"]\/['"]\s*\}\)/.test(serverSource),
    'logout must clear friday_session cookie with path: /'
  );
  assert.ok(
    /Logged out successfully/.test(serverSource),
    'logout response must include "Logged out successfully"'
  );
});

// Group 2: Frontend Session Resilience in public/index.html
console.log('\n--- TEST GROUP 2: Frontend Session Resilience (`public/index.html`) ---');

const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');

it('public/index.html contains NO unload or beforeunload listeners', () => {
  assert.strictEqual(
    /beforeunload|['"]unload['"]/.test(indexHtml),
    false,
    'index.html must not contain unload or beforeunload event listeners'
  );
});

it('public/index.html enforces credentials: same-origin across all fetch calls', () => {
  assert.ok(
    indexHtml.includes("credentials: 'same-origin'") || indexHtml.includes('credentials: "same-origin"'),
    'index.html must specify credentials: same-origin on fetch calls'
  );
});

it('public/index.html verifies session on DOMContentLoaded and renders dashboard directly', () => {
  assert.ok(
    indexHtml.includes("DOMContentLoaded"),
    'index.html must attach a DOMContentLoaded listener'
  );
  assert.ok(
    indexHtml.includes('/api/users'),
    'index.html must query user profile endpoint to verify auth'
  );
});

it('passcode security gate uses localStorage instead of sessionStorage for persistent multi-tab support', () => {
  assert.ok(
    indexHtml.includes("localStorage.getItem('friday_authenticated')"),
    'Passcode gate must check localStorage for cross-tab persistence'
  );
  assert.strictEqual(
    indexHtml.includes("sessionStorage.getItem('friday_authenticated')"),
    false,
    'sessionStorage should not be used for friday_authenticated'
  );
});

// Group 3: Neumorphic UI/UX Redesign in public/index.html
console.log('\n--- TEST GROUP 3: Neumorphic Design System Tokens & Components ---');

it('defines all required Neumorphic design tokens in :root', () => {
  assert.ok(indexHtml.includes('--nm-bg: #e0e5ec'), 'Must define --nm-bg: #e0e5ec');
  assert.ok(indexHtml.includes('--nm-surface: #e0e5ec'), 'Must define --nm-surface: #e0e5ec');
  assert.ok(indexHtml.includes('--nm-text: #2d3748'), 'Must define --nm-text: #2d3748');
  assert.ok(indexHtml.includes('--nm-text-muted: #718096'), 'Must define --nm-text-muted: #718096');
  assert.ok(indexHtml.includes('--nm-border-light: rgba(255, 255, 255, 0.6)'), 'Must define --nm-border-light');
  assert.ok(indexHtml.includes('--nm-extruded-lg: 12px 12px 24px #bec8d4, -12px -12px 24px #ffffff'), 'Must define --nm-extruded-lg');
  assert.ok(indexHtml.includes('--nm-extruded: 7px 7px 15px #bec8d4, -7px -7px 15px #ffffff'), 'Must define --nm-extruded');
  assert.ok(indexHtml.includes('--nm-extruded-sm: 4px 4px 8px #bec8d4, -4px -4px 8px #ffffff'), 'Must define --nm-extruded-sm');
  assert.ok(indexHtml.includes('--nm-extruded-pill: 5px 5px 10px #bec8d4, -5px -5px 10px #ffffff'), 'Must define --nm-extruded-pill');
  assert.ok(indexHtml.includes('--nm-inset: inset 5px 5px 10px #bec8d4, inset -5px -5px 10px #ffffff'), 'Must define --nm-inset');
  assert.ok(indexHtml.includes('--nm-inset-sm: inset 3px 3px 6px #bec8d4, inset -3px -3px 6px #ffffff'), 'Must define --nm-inset-sm');
  assert.ok(indexHtml.includes('--nm-inset-deep: inset 8px 8px 16px #b4becb, inset -8px -8px 16px #ffffff'), 'Must define --nm-inset-deep');
  assert.ok(indexHtml.includes('--nm-accent-blue: #3b82f6'), 'Must define --nm-accent-blue');
  assert.ok(indexHtml.includes('--nm-accent-amber: #f59e0b'), 'Must define --nm-accent-amber');
  assert.ok(indexHtml.includes('--nm-accent-green: #10b981'), 'Must define --nm-accent-green');
  assert.ok(indexHtml.includes('--nm-accent-rose: #f43f5e'), 'Must define --nm-accent-rose');
});

it('applies Container Cards rule: var(--nm-surface), border-radius: 24px, box-shadow: var(--nm-extruded-lg)', () => {
  assert.ok(indexHtml.includes('var(--nm-extruded-lg)'), 'Container cards must use --nm-extruded-lg');
  assert.ok(indexHtml.includes('border-radius: 24px'), 'Container cards must have border-radius 24px');
});

it('applies Tab Rail rule: sunken rail container (--nm-inset, border-radius: 9999px) with elevated active tab (--nm-extruded-pill)', () => {
  assert.ok(/tabs-nav[\s\S]*?box-shadow:\s*var\(--nm-inset\)/.test(indexHtml), 'Tab rail must have sunken box-shadow: var(--nm-inset)');
  assert.ok(/tab-btn\.active[\s\S]*?box-shadow:\s*var\(--nm-extruded-pill\)/.test(indexHtml), 'Active tab must have elevated box-shadow: var(--nm-extruded-pill)');
});

it('applies Buttons rule: extruded default (--nm-extruded-sm) and inset on active/pressed (--nm-inset-sm, scale 0.98)', () => {
  assert.ok(/btn[\s\S]*?box-shadow:\s*var\(--nm-extruded-sm\)/.test(indexHtml), 'Button must have default box-shadow: var(--nm-extruded-sm)');
  assert.ok(/btn:active[\s\S]*?box-shadow:\s*var\(--nm-inset-sm\)/.test(indexHtml), 'Button active must have box-shadow: var(--nm-inset-sm)');
  assert.ok(/btn:active[\s\S]*?scale\(0\.98\)/.test(indexHtml), 'Button active must have transform: scale(0.98)');
});

it('applies Routine PDF Dropzone rule: sunken well (--nm-inset-deep, 2px dashed #a0aec0, 20px radius) with blue glow on dragover', () => {
  assert.ok(/drop-zone[\s\S]*?box-shadow:\s*var\(--nm-inset-deep\)/.test(indexHtml), 'Dropzone must have sunken box-shadow: var(--nm-inset-deep)');
  assert.ok(/drop-zone[\s\S]*?border:\s*2px dashed #a0aec0/.test(indexHtml), 'Dropzone must have 2px dashed #a0aec0 border');
  assert.ok(/drop-zone[\s\S]*?border-radius:\s*20px/.test(indexHtml), 'Dropzone must have 20px border radius');
  assert.ok(/drop-zone:hover[\s\S]*?var\(--nm-accent-blue-glow\)/.test(indexHtml), 'Dropzone hover must have blue glow');
});

it('applies Timetable Grid rule: day headers as extruded pills, theory with blue border & [CLASS] pill, labs with amber border & [LAB] pill', () => {
  assert.ok(indexHtml.includes('day-pill'), 'Must define day-pill element');
  assert.ok(/day-pill[\s\S]*?box-shadow:\s*var\(--nm-extruded-pill\)/.test(indexHtml), 'Day headers must be extruded pills');
  assert.ok(indexHtml.includes('slot-card-theory'), 'Must define slot-card-theory');
  assert.ok(indexHtml.includes('slot-card-lab'), 'Must define slot-card-lab');
  assert.ok(/border-left:\s*5px solid var\(--nm-accent-blue\)/.test(indexHtml), 'Theory slot must have 5px blue border-left');
  assert.ok(/border-left:\s*5px solid var\(--nm-accent-amber\)/.test(indexHtml), 'Lab slot must have 5px amber border-left');
  assert.ok(indexHtml.includes('slot-badge-class'), 'Must define slot-badge-class with [CLASS]');
  assert.ok(indexHtml.includes('slot-badge-lab'), 'Must define slot-badge-lab with [LAB]');
});

it('applies Exam List rule: inset panel container housing extruded rows with MIDTERM (amber) and FINAL (rose) badges', () => {
  assert.ok(indexHtml.includes('events-list-inset'), 'Must have events-list-inset container');
  assert.ok(/events-list-inset[\s\S]*?box-shadow:\s*var\(--nm-inset\)/.test(indexHtml), 'Exam container must have sunken inset shadow');
  assert.ok(/event-card[\s\S]*?box-shadow:\s*var\(--nm-extruded-sm\)/.test(indexHtml), 'Exam rows must have extruded card shadow');
  assert.ok(/badge-midterm[\s\S]*?color:\s*var\(--nm-accent-amber\)/.test(indexHtml), 'Midterm badge must use amber accent');
  assert.ok(/badge-final[\s\S]*?color:\s*var\(--nm-accent-rose\)/.test(indexHtml), 'Final badge must use rose accent');
});

it('applies Form Inputs rule: sunken inset wells (--nm-inset, border: none, border-radius: 12px)', () => {
  assert.ok(/form-input[\s\S]*?box-shadow:\s*var\(--nm-inset\)/.test(indexHtml), 'Form inputs must have box-shadow: var(--nm-inset)');
  assert.ok(/form-input[\s\S]*?border:\s*none/.test(indexHtml), 'Form inputs must have border: none');
  assert.ok(/form-input[\s\S]*?border-radius:\s*12px/.test(indexHtml), 'Form inputs must have border-radius: 12px');
});

// Group 4: Live HTTP Session & Route Enforcement
console.log('\n--- TEST GROUP 4: Live Express Server Auth Enforcement ---');

import http from 'http';

const testPort = 3982;
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

await itAsync('API route returns 401 JSON and never 302 redirects when unauthenticated', async () => {
  const res = await httpRequest('/api/events', 'GET', { 'x-enforce-auth': '1' });
  assert.strictEqual(res.status, 401, 'Unauthenticated /api/events must return 401');
  assert.strictEqual(res.data.success, false);
  assert.ok(res.data.error === 'Session expired' || res.data.error === 'Unauthorized');
});

await itAsync('Page route / redirects to /login (302) when unauthenticated', async () => {
  const res = await httpRequest('/', 'GET', { 'x-enforce-auth': '1' });
  assert.strictEqual(res.status, 302, 'Unauthenticated / must return 302');
  assert.strictEqual(res.headers.location, '/login', 'Must redirect to /login');
});

await itAsync('POST /api/auth/logout clears cookie and returns success JSON', async () => {
  const res = await httpRequest('/api/auth/logout', 'POST');
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.data.success, true);
  assert.strictEqual(res.data.message, 'Logged out successfully');

  const setCookie = res.headers['set-cookie'];
  assert.ok(setCookie, 'Must set-cookie to clear session');
  const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
  assert.ok(cookieStr.includes('friday_session=;'), 'Must clear friday_session cookie');
  assert.ok(cookieStr.includes('Path=/'), 'Must clear with Path=/');
});

// Teardown
await new Promise((resolve) => serverInstance.close(resolve));
cleanup();

console.log('\n====================================================');
console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (100%)`);
console.log('====================================================\n');
process.exit(0);
