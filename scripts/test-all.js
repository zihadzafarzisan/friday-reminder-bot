import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { DEFAULT_DB_PATH, TEST_DB_PATH } from '../src/db/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

const testSuites = [
  { name: 'Phase 4.1 Bug Fixes & Settings', script: 'scripts/test-phase4.1.js' },
  { name: 'Discord Slash Commands & Modals', script: 'scripts/test-slash-commands.js' },
  { name: 'Phase 5 Multi-Tenant Architecture', script: 'scripts/test-phase5.js' },
  { name: 'Faculty Consultation Lookup', script: 'scripts/test-consultations.js' },
  { name: '100% Discord-Native Automation', script: 'scripts/test-discord-native.js' },
  { name: 'Docker & Volume Configuration', script: 'scripts/test-docker-config.js' },
  { name: 'Unified Server & Bot Architecture', script: 'scripts/test-unified-process.js' }
];

function runTest(suite) {
  return new Promise((resolve) => {
    console.log(`\n====================================================`);
    console.log(`  RUNNING: ${suite.name}`);
    console.log(`  Target: ${suite.script}`);
    console.log(`====================================================\n`);

    const child = spawn(process.execPath, [path.join(ROOT_DIR, suite.script)], {
      cwd: ROOT_DIR,
      stdio: 'inherit',
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DB_PATH: TEST_DB_PATH
      }
    });

    child.on('close', (code) => {
      resolve({ name: suite.name, code, passed: code === 0 });
    });
  });
}

async function main() {
  console.log('####################################################');
  console.log('  RUNNING COMPLETE ISOLATED TEST SUITE');
  console.log(`  Academic DB: ${DEFAULT_DB_PATH} (PROTECTED)`);
  console.log(`  Test DB:     ${TEST_DB_PATH} (ISOLATED)`);
  console.log('####################################################\n');

  // Record academic.db stats before tests
  let academicMtimeBefore = null;
  if (fs.existsSync(DEFAULT_DB_PATH)) {
    academicMtimeBefore = fs.statSync(DEFAULT_DB_PATH).mtimeMs;
  }

  const results = [];
  for (const suite of testSuites) {
    const res = await runTest(suite);
    results.push(res);
  }

  // Verify test.db cleanup
  const testDbExists = fs.existsSync(TEST_DB_PATH);

  // Verify academic.db was NOT touched
  let academicMtimeAfter = null;
  if (fs.existsSync(DEFAULT_DB_PATH)) {
    academicMtimeAfter = fs.statSync(DEFAULT_DB_PATH).mtimeMs;
  }
  const academicUntouched = academicMtimeBefore === academicMtimeAfter;

  console.log('\n====================================================');
  console.log('  TEST SUITE AGGREGATE SUMMARY');
  console.log('====================================================');
  let allPassed = true;
  for (const r of results) {
    const icon = r.passed ? '✅ [PASS]' : '❌ [FAIL]';
    console.log(`  ${icon} ${r.name}`);
    if (!r.passed) allPassed = false;
  }

  console.log('\n--- ISOLATION VERIFICATION ---');
  console.log(`  Temporary test.db unlinked cleanly:   ${!testDbExists ? '✅ YES' : '❌ NO'}`);
  console.log(`  Production academic.db untouched:    ${academicUntouched ? '✅ YES' : '❌ MODIFIED'}`);
  console.log('====================================================\n');

  if (!allPassed || testDbExists || !academicUntouched) {
    console.error('[!] Test suite failures or isolation breach detected.');
    process.exit(1);
  } else {
    console.log('[+] All test suites passed with 100% database isolation!\n');
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('[FATAL] Test runner crashed:', err);
  process.exit(1);
});
