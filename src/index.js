import 'dotenv/config';
import { getDb } from './db/index.js';
import { getDiscordClient, closeDiscordClient } from './bot.js';
import { startReminderEngine, stopReminderEngine } from './reminder-engine.js';

const INTERVAL_MINUTES = parseInt(process.env.REMINDER_INTERVAL_MINUTES || '1', 10);

async function main() {
  console.log('====================================================');
  console.log('  FRIDAY ACADEMIC ASSISTANT — REMINDER SERVICE (MULTI-TENANT)');
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

  // Start the centralized reminder engine (handles immediate startup tick and interval loop)
  startReminderEngine({ db, discordClient: client, intervalMinutes: INTERVAL_MINUTES });

  // Graceful shutdown
  const shutdown = async () => {
    console.log('\n[*] Shutting down Academic Reminder Service...');
    stopReminderEngine();
    await closeDiscordClient();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(async (err) => {
  console.error('\n[FATAL] Reminder service crashed:');
  console.error(err);
  stopReminderEngine();
  await closeDiscordClient();
  process.exit(1);
});
