import 'dotenv/config';
import { getDb } from './db/index.js';
import { getDiscordClient, closeDiscordClient } from './bot.js';
import { runEvaluationTick, getDhakaContext } from './reminder-engine.js';

const INTERVAL_MINUTES = parseInt(process.env.REMINDER_INTERVAL_MINUTES || '1', 10);
const INTERVAL_MS = INTERVAL_MINUTES * 60 * 1000;

async function main() {
  console.log('====================================================');
  console.log('  BRACU CONNECT — ACADEMIC REMINDER SERVICE (MULTI-TENANT)');
  console.log('====================================================');

  const token = process.env.DISCORD_BOT_TOKEN;

  if (!token) {
    console.error('[!] Missing DISCORD_BOT_TOKEN in .env.');
    console.error('Please configure your credentials in .env.');
    process.exit(1);
  }

  const db = getDb();
  console.log('[+] Database connection active.');

  const client = await getDiscordClient(token);
  const userCount = db.prepare('SELECT count(*) as c FROM users').get()?.c || 0;
  console.log(`[+] Discord client active. Monitoring reminders across ${userCount} registered user(s).`);
  console.log(`[+] Timezone: Asia/Dhaka | Evaluation interval: Every ${INTERVAL_MINUTES} minute(s)\n`);

  // Run immediate first evaluation tick
  try {
    const initialDispatches = await runEvaluationTick({ db, discordClient: client });
    if (initialDispatches.length > 0) {
      console.log(`[+] Startup tick: Dispatched ${initialDispatches.length} reminder(s).`);
    } else {
      const now = getDhakaContext();
      console.log(`[+] Startup tick (${now.isoDhaka}): No pending reminders due right now.`);
    }
  } catch (err) {
    console.error('[!] Error during startup evaluation tick:', err.message);
  }

  // Periodic evaluation loop
  const timer = setInterval(async () => {
    try {
      const dispatches = await runEvaluationTick({ db, discordClient: client });
      if (dispatches.length > 0) {
        for (const d of dispatches) {
          console.log(`[+] Dispatched [${d.type}] ${d.offset} for user ${d.userId} (${d.course}) - Status: ${d.status}`);
        }
      }
    } catch (err) {
      console.error('[!] Error during evaluation tick:', err.message);
    }
  }, INTERVAL_MS);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[*] Shutting down Academic Reminder Service...');
    clearInterval(timer);
    await closeDiscordClient();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error('\n[FATAL] Reminder service crashed:');
  console.error(err);
  await closeDiscordClient();
  process.exit(1);
});
