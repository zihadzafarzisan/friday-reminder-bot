import assert from 'assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb, getDbPath, closeDb, DEFAULT_DB_PATH } from '../src/db/index.js';
import { createServer } from '../src/server.js';
import { apps } from '../ecosystem.config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

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

async function runTests() {
  console.log('====================================================');
  console.log('  TESTING DOCKER & CLOUD VOLUME CONFIGURATION');
  console.log('====================================================\n');

  // --- TEST GROUP 1: Configurable DB_PATH ---
  console.log('--- TEST GROUP 1: Configurable DB_PATH in src/db/index.js ---');

  const originalDbPathEnv = process.env.DB_PATH;
  delete process.env.DB_PATH;

  it('Default DB path resolves to data/academic.db when process.env.DB_PATH is empty', () => {
    const resolved = getDbPath();
    assert.strictEqual(resolved, DEFAULT_DB_PATH);
    assert.ok(resolved.endsWith(path.join('data', 'academic.db')));
  });

  const testCustomPath = path.join(ROOT_DIR, 'data', 'test_cloud_volume', 'test_custom.db');
  it('Resolves custom path when process.env.DB_PATH is specified', () => {
    process.env.DB_PATH = testCustomPath;
    const resolved = getDbPath();
    assert.strictEqual(resolved, path.resolve(testCustomPath));
  });

  it('Creates target directory automatically if not existing when initializing SQLite', () => {
    closeDb();
    const testDir = path.dirname(testCustomPath);
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    assert.strictEqual(fs.existsSync(testDir), false, 'Test directory should not exist initially');

    process.env.DB_PATH = testCustomPath;
    const db = getDb();
    assert.ok(db, 'Database instance should be initialized');
    assert.ok(fs.existsSync(testDir), 'Directory should be automatically created');
    assert.ok(fs.existsSync(testCustomPath), 'Database file should be created in the target volume');

    closeDb();
    // Clean up test file & directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  // Restore env
  if (originalDbPathEnv !== undefined) {
    process.env.DB_PATH = originalDbPathEnv;
  } else {
    delete process.env.DB_PATH;
  }
  closeDb();

  // --- TEST GROUP 2: Network & 0.0.0.0 Port Binding ---
  console.log('\n--- TEST GROUP 2: Network & 0.0.0.0 Port Binding in src/server.js ---');

  await itAsync('Server can bind to 0.0.0.0 and listen on dynamic port', async () => {
    const app = createServer();
    const testPort = 3999;
    const testHost = '0.0.0.0';

    const server = await new Promise((resolve, reject) => {
      const s = app.listen(testPort, testHost, () => resolve(s));
      s.on('error', reject);
    });

    const addr = server.address();
    assert.ok(addr, 'Server address should be valid');
    assert.strictEqual(addr.port, testPort);
    assert.strictEqual(addr.address, '0.0.0.0');

    await new Promise(resolve => server.close(resolve));
  });

  // --- TEST GROUP 3: Dockerfile Validation ---
  console.log('\n--- TEST GROUP 3: Dockerfile Structure & Directives ---');

  const dockerfilePath = path.join(ROOT_DIR, 'Dockerfile');
  it('Dockerfile exists in project root', () => {
    assert.ok(fs.existsSync(dockerfilePath), 'Dockerfile must exist');
  });

  const dockerfileContent = fs.readFileSync(dockerfilePath, 'utf-8');

  it('Dockerfile uses node:20-alpine as base image', () => {
    assert.ok(/FROM\s+node:20-alpine/i.test(dockerfileContent), 'Must use FROM node:20-alpine');
  });

  it('Dockerfile configures tzdata and ENV TZ="Asia/Dhaka"', () => {
    assert.ok(/tzdata/i.test(dockerfileContent), 'Must install tzdata');
    assert.ok(/TZ[=\s]+"Asia\/Dhaka"/i.test(dockerfileContent) || /TZ[=\s]+Asia\/Dhaka/i.test(dockerfileContent), 'Must set TZ to Asia/Dhaka');
  });

  it('Dockerfile installs pm2 globally', () => {
    assert.ok(/npm\s+install\s+-g\s+pm2/i.test(dockerfileContent), 'Must install pm2 globally');
  });

  it('Dockerfile copies package*.json and executes npm ci --omit=dev', () => {
    assert.ok(/COPY\s+package\*\.json/i.test(dockerfileContent), 'Must copy package*.json');
    assert.ok(/npm\s+ci\s+--omit=dev/i.test(dockerfileContent), 'Must run npm ci --omit=dev');
  });

  it('Dockerfile creates mount directory /data', () => {
    assert.ok(/mkdir\s+(-p\s+)?\/data/i.test(dockerfileContent), 'Must create /data mount directory');
  });

  it('Dockerfile exposes port 3000', () => {
    assert.ok(/EXPOSE\s+3000/i.test(dockerfileContent), 'Must EXPOSE 3000');
  });

  it('Dockerfile sets CMD to ["pm2-runtime", "ecosystem.config.js"]', () => {
    assert.ok(/CMD\s+\[\s*"pm2-runtime"\s*,\s*"ecosystem\.config\.js"\s*\]/i.test(dockerfileContent), 'Must use CMD ["pm2-runtime", "ecosystem.config.js"]');
  });

  // --- TEST GROUP 4: .dockerignore Validation ---
  console.log('\n--- TEST GROUP 4: .dockerignore Entries ---');

  const dockerignorePath = path.join(ROOT_DIR, '.dockerignore');
  it('.dockerignore exists in project root', () => {
    assert.ok(fs.existsSync(dockerignorePath), '.dockerignore must exist');
  });

  const dockerignoreContent = fs.readFileSync(dockerignorePath, 'utf-8');
  const lines = dockerignoreContent.split('\n').map(l => l.trim()).filter(Boolean);

  it('.dockerignore ignores node_modules', () => {
    assert.ok(lines.includes('node_modules'));
  });

  it('.dockerignore ignores .env', () => {
    assert.ok(lines.includes('.env'));
  });

  it('.dockerignore ignores academic.db', () => {
    assert.ok(lines.includes('academic.db'));
  });

  it('.dockerignore ignores data/', () => {
    assert.ok(lines.includes('data/'));
  });

  it('.dockerignore ignores .git', () => {
    assert.ok(lines.includes('.git'));
  });

  it('.dockerignore ignores .auth_profile/', () => {
    assert.ok(lines.includes('.auth_profile/'));
  });

  // --- TEST GROUP 5: ecosystem.config.js Environment Inheritance ---
  console.log('\n--- TEST GROUP 5: ecosystem.config.js Environment Variables ---');

  it('ecosystem.config.js defines friday-bot with DB_PATH and TIMEZONE', () => {
    const botApp = apps.find(a => a.name === 'friday-bot');
    assert.ok(botApp, 'friday-bot must be defined');
    assert.ok(botApp.env, 'friday-bot must have env block');
    assert.strictEqual(botApp.env.TIMEZONE, 'Asia/Dhaka');
    assert.ok('DB_PATH' in botApp.env, 'DB_PATH must be in env block');
  });

  it('ecosystem.config.js defines friday-dashboard with DB_PATH, TIMEZONE, PORT and HOST', () => {
    const dashApp = apps.find(a => a.name === 'friday-dashboard');
    assert.ok(dashApp, 'friday-dashboard must be defined');
    assert.ok(dashApp.env, 'friday-dashboard must have env block');
    assert.strictEqual(dashApp.env.TIMEZONE, 'Asia/Dhaka');
    assert.strictEqual(dashApp.env.PORT, 3000);
    assert.strictEqual(dashApp.env.HOST, '0.0.0.0');
    assert.ok('DB_PATH' in dashApp.env, 'DB_PATH must be in env block');
  });

  console.log('\n====================================================');
  console.log(`  DOCKER CONFIG TEST RESULTS: ${passed}/${passed + failed} TESTS PASSED (${Math.round((passed / (passed + failed)) * 100)}%)`);
  console.log('====================================================');

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('[!] Test suite fatal error:', err);
  process.exit(1);
});
