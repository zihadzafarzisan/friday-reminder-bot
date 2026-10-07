import assert from 'assert';
import fs from 'fs';
import path from 'path';
import http from 'http';
import { fileURLToPath } from 'url';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { createServer, startServer, stopServer } from '../src/server.js';
import { initBot, stopBot } from '../src/index.js';
import { isReminderEngineRunning } from '../src/reminder-engine.js';
import { getActiveDiscordClient } from '../src/bot.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

async function main() {
  console.log('====================================================');
  console.log('  TESTING UNIFIED SERVER + DISCORD BOT ARCHITECTURE');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();
  let passed = 0;
  let total = 0;

  function test(condition, name) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${name}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${name}`);
    }
  }

  // --- TEST GROUP 1: /ping Route Verification ---
  console.log('--- TEST GROUP 1: /ping Route Verification ---');
  const app = createServer();
  const testPort = 4055;
  const tempServer = await new Promise(resolve => {
    const s = app.listen(testPort, '127.0.0.1', () => resolve(s));
  });

  try {
    // 1. GET /ping
    const getRes = await fetch(`http://127.0.0.1:${testPort}/ping`);
    const getBody = await getRes.text();
    const contentType = getRes.headers.get('content-type');

    test(getRes.status === 200, 'GET /ping returns 200 OK');
    test(contentType === 'text/plain; charset=utf-8', `GET /ping Content-Type is text/plain; charset=utf-8 (got: ${contentType})`);
    test(getBody === 'OK', `GET /ping body is exactly "OK" (got: "${getBody}")`);
    test(Buffer.byteLength(getBody, 'utf8') === 2, `GET /ping body byte length is 2 bytes (got: ${Buffer.byteLength(getBody, 'utf8')})`);

    // 2. HEAD /ping
    const headRes = await fetch(`http://127.0.0.1:${testPort}/ping`, { method: 'HEAD' });
    test(headRes.status === 200, 'HEAD /ping returns 200 OK');
    test(headRes.headers.get('content-type') === 'text/plain; charset=utf-8', 'HEAD /ping has correct Content-Type header');
  } finally {
    await new Promise(resolve => tempServer.close(resolve));
  }

  // --- TEST GROUP 2: package.json Default Entrypoint ---
  console.log('\n--- TEST GROUP 2: package.json Configuration ---');
  const pkgPath = path.join(ROOT_DIR, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  test(pkg.scripts.start === 'node src/server.js', `package.json "start" script points to "node src/server.js" (got: "${pkg.scripts.start}")`);
  test(pkg.scripts.dashboard === 'node src/server.js', 'package.json "dashboard" script points to "node src/server.js"');

  // --- TEST GROUP 3: Guard Against Duplicate Bot Logins ---
  console.log('\n--- TEST GROUP 3: Duplicate Login Guard ---');

  // Call initBot multiple times concurrently
  const p1 = initBot({ db });
  const p2 = initBot({ db });
  const p3 = initBot({ db });

  test(p1 === p2 && p2 === p3, 'Concurrent initBot() calls return the identical shared Promise');
  const client1 = await p1;

  // Call initBot again sequentially after ready
  const client2 = await initBot({ db });
  test(client1 === client2, 'Sequential initBot() calls return the identical Client instance without re-logging in');

  // --- TEST GROUP 4: Unified startServer() Lifecycle & Engine Start ---
  console.log('\n--- TEST GROUP 4: startServer() Lifecycle & Engine Start ---');

  test(isReminderEngineRunning() === true, 'Reminder evaluation loop is active in the same process');
  test(getActiveDiscordClient() !== null, 'Discord client is active in the same process');

  const unifiedPort = 4056;
  const unifiedServer = startServer(unifiedPort, '127.0.0.1');

  // Verify server is listening
  await new Promise(resolve => setTimeout(resolve, 300));
  const statusRes = await fetch(`http://127.0.0.1:${unifiedPort}/ping`);
  test(statusRes.status === 200, 'Unified server responds to /ping on configured port');

  // Calling startServer() again does NOT create duplicate reminder loops
  const secondServer = startServer(unifiedPort + 1, '127.0.0.1');
  test(isReminderEngineRunning() === true, 'Reminder engine remains safely active after second startServer() call');

  // --- TEST GROUP 5: Graceful Shutdown Verification ---
  console.log('\n--- TEST GROUP 5: Graceful Shutdown Verification ---');

  // Close secondServer first
  await stopServer(secondServer);
  // Close unifiedServer and verify full teardown of Express listener & Discord client
  await stopServer(unifiedServer);

  test(isReminderEngineRunning() === false, 'stopServer() cleanly stops the reminder engine loop');
  test(getActiveDiscordClient() === null, 'stopServer() cleanly destroys the Discord client connection');

  // Clean up test DB
  cleanup();

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed / total) * 100)}%)`);
  console.log('====================================================\n');

  if (passed !== total) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('[FATAL] Test failed:', err);
  process.exit(1);
});
