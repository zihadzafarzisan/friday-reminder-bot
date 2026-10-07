import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const AUTH_PROFILE_DIR = path.join(ROOT_DIR, '.auth_profile');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const OUTPUT_FILE = path.join(DATA_DIR, 'schedule_raw.json');
const TARGET_URL = 'https://connect.bracu.ac.bd/student/schedule';

async function main() {
  console.log('====================================================');
  console.log('  BRACU CONNECT — PHASE 1: SCHEDULE INGESTION');
  console.log('====================================================');
  console.log(`[+] Using persistent profile at: ${AUTH_PROFILE_DIR}`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // Determine whether Chrome is available, fallback to bundled chromium
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const useSystemChrome = fs.existsSync(chromePath);
  console.log(`[+] Browser engine: ${useSystemChrome ? 'Google Chrome (System)' : 'Chromium (Bundled)'}`);

  const launchOptions = {
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: ['--disable-blink-features=AutomationControlled']
  };

  if (useSystemChrome) {
    launchOptions.channel = 'chrome';
  }

  const context = await chromium.launchPersistentContext(AUTH_PROFILE_DIR, launchOptions);
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

  let capturedBearerToken = null;
  let interceptedScheduleData = null;

  // Intercept network requests across all pages/tabs in the context
  context.on('request', (request) => {
    const authHeader = request.headers()['authorization'];
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      capturedBearerToken = authHeader;
    }
  });

  context.on('response', async (response) => {
    const url = response.url();
    if (url.includes('/api/adv/v1/student-courses/schedules') && response.status() === 200) {
      try {
        interceptedScheduleData = await response.json();
      } catch (err) {
        // Body might already be consumed
      }
    }
  });

  console.log(`[+] Navigating to: ${TARGET_URL}`);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Check if SSO login is needed
  let isRedirectedToSSO = false;
  for (let i = 0; i < 16; i++) {
    const u = page.url();
    if (u.includes('sso.bracu.ac.bd') || u.includes('accounts.google.com')) {
      isRedirectedToSSO = true;
      break;
    }
    if (capturedBearerToken) break;
    await page.waitForTimeout(500);
  }

  if (isRedirectedToSSO || (!capturedBearerToken && page.url().includes('sso.bracu.ac.bd'))) {
    console.log('\n----------------------------------------------------');
    console.log('>>> ACTION REQUIRED: MANUAL LOGIN REQUIRED <<<');
    console.log('1. In the browser window, log in with your BRACU Google account.');
    console.log('2. Complete any MFA/2FA prompts.');
    console.log('3. The script will automatically detect once you land in the portal.');
    console.log('----------------------------------------------------\n');

    // Wait until login completes and browser returns to connect.bracu.ac.bd
    await page.waitForURL((url) => {
      const u = url.toString();
      return u.includes('connect.bracu.ac.bd') && !u.includes('sso.bracu.ac.bd') && !u.includes('accounts.google.com');
    }, { timeout: 600000 });

    console.log('[+] Authentication completed! Returned to BRACU Connect portal.');
  }

  // Ensure navigation lands on the schedule page
  if (!page.url().includes('/student/schedule')) {
    console.log('[+] Navigating directly to /student/schedule...');
    await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }

  console.log('[+] Waiting for authenticated session and token initialization...');

  const waitStart = Date.now();
  while (!capturedBearerToken && Date.now() - waitStart < 45000) {
    if (page.url().includes('sso.bracu.ac.bd') || page.url().includes('accounts.google.com')) {
      await page.waitForTimeout(1000);
      continue;
    }
    await page.waitForTimeout(500);
  }

  if (!capturedBearerToken) {
    console.log('[*] Triggering page reload to refresh token...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const reloadStart = Date.now();
    while (!capturedBearerToken && Date.now() - reloadStart < 15000) {
      await page.waitForTimeout(500);
    }
  }

  if (!capturedBearerToken) {
    throw new Error('Failed to capture Authorization Bearer token from the browser session.');
  }

  console.log('[+] Authenticated Bearer token successfully captured.');
  console.log('[+] Executing authenticated handshake via page.evaluate()...');

  // Perform handshake: a, b, c
  const handshakeResult = await page.evaluate(async (token) => {
    const headers = {
      'Authorization': token,
      'Content-Type': 'application/json',
      'ignore-global-handler': 'true'
    };

    // a. GET /api/mds/v1/portfolios
    const portfoliosResp = await fetch('/api/mds/v1/portfolios', { headers });
    if (!portfoliosResp.ok) {
      throw new Error(`Failed to fetch portfolios: HTTP ${portfoliosResp.status} ${portfoliosResp.statusText}`);
    }
    const portfolios = await portfoliosResp.json();
    if (!Array.isArray(portfolios) || portfolios.length === 0) {
      throw new Error('No academic portfolio found in response.');
    }

    const primaryPortfolio = portfolios[0];
    const portfolioId = primaryPortfolio.id;

    // b. GET /api/adv/v1/student-courses/sessions?studentPortfolioId={portfolioId}
    const sessionsResp = await fetch(`/api/adv/v1/student-courses/sessions?studentPortfolioId=${portfolioId}`, { headers });
    if (!sessionsResp.ok) {
      throw new Error(`Failed to fetch sessions: HTTP ${sessionsResp.status} ${sessionsResp.statusText}`);
    }
    const sessions = await sessionsResp.json();
    const activeSession = sessions[0];
    const semesterSessionId = activeSession?.semesterSessionId || activeSession?.id;

    // c. GET /api/adv/v1/student-courses/schedules?studentPortfolioId={portfolioId}&semesterSessionId={sessionId}
    const scheduleUrl = `/api/adv/v1/student-courses/schedules?studentPortfolioId=${portfolioId}${semesterSessionId ? `&semesterSessionId=${semesterSessionId}` : ''}`;
    const scheduleResp = await fetch(scheduleUrl, { headers });
    if (!scheduleResp.ok) {
      throw new Error(`Failed to fetch schedule: HTTP ${scheduleResp.status} ${scheduleResp.statusText}`);
    }
    const scheduleData = await scheduleResp.json();

    return {
      portfolioId,
      portfolio: primaryPortfolio,
      semesterSessionId,
      semesterSession: activeSession,
      allSessions: sessions,
      schedule: scheduleData,
      fetchedAt: new Date().toISOString()
    };
  }, capturedBearerToken);

  if (interceptedScheduleData && (!handshakeResult.schedule || handshakeResult.schedule.length === 0)) {
    console.log('[*] Using intercepted schedule payload as fallback.');
    handshakeResult.schedule = interceptedScheduleData;
  }

  const formattedJson = JSON.stringify(handshakeResult, null, 2);
  fs.writeFileSync(OUTPUT_FILE, formattedJson, 'utf-8');

  const courseCount = Array.isArray(handshakeResult.schedule) ? handshakeResult.schedule.length : 0;
  const fileSizeKB = (Buffer.byteLength(formattedJson, 'utf-8') / 1024).toFixed(2);

  console.log('\n====================================================');
  console.log(`[SUCCESS] Raw schedule captured successfully!`);
  console.log(`[+] File written: ${OUTPUT_FILE}`);
  console.log(`[+] Courses/Sections captured: ${courseCount}`);
  console.log(`[+] File size: ${fileSizeKB} KB`);
  console.log(`[+] Portfolio ID: ${handshakeResult.portfolioId}`);
  console.log(`[+] Semester Session: ${handshakeResult.semesterSession?.description || handshakeResult.semesterSessionId}`);
  console.log('====================================================\n');

  await context.close();
}

main().catch((err) => {
  console.error('\n[ERROR] An error occurred during schedule ingestion:');
  console.error(err.message || err);
  process.exit(1);
});
