import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from './db/index.js';
import { getDiscordClient, closeDiscordClient } from './bot.js';
import { startReminderEngine, stopReminderEngine } from './reminder-engine.js';

const INTERVAL_MINUTES = parseInt(process.env.REMINDER_INTERVAL_MINUTES || '1', 10);

let botClient = null;
let botInitPromise = null;

/**
 * Initializes and logs in the Discord Bot and starts the reminder evaluation loop.
 * Guards against duplicate bot logins if called multiple times concurrently or sequentially.
 */
export function initBot(options = {}) {
  // If the bot client is already ready, return existing client instance
  if (botClient && botClient.isReady()) {
    return Promise.resolve(botClient);
  }

  // If initialization is already in flight, reuse the active promise
  if (botInitPromise) {
    return botInitPromise;
  }

  botInitPromise = (async () => {
    console.log('====================================================');
    console.log('  FRIDAY ACADEMIC ASSISTANT — DISCORD BOT SERVICE');
    console.log('====================================================');

    const token = options.token || process.env.DISCORD_BOT_TOKEN;

    if (!token) {
      console.warn('[!] Missing DISCORD_BOT_TOKEN in environment. Discord bot client skipped.');
      botInitPromise = null;
      return null;
    }

    const db = options.db || getDb();
    console.log('[+] Database connection active.');

    const client = await getDiscordClient(token);
    botClient = client;

    const userCount = db.prepare('SELECT count(*) as c FROM users').get()?.c || 0;
    console.log(`[+] Discord client active. Monitoring reminders across ${userCount} registered user(s).`);
    console.log(`[+] Timezone: Asia/Dhaka | Evaluation interval: Every ${options.intervalMinutes || INTERVAL_MINUTES} minute(s)\n`);

    // Start the centralized reminder engine (handles immediate startup tick and interval loop)
    startReminderEngine({
      db,
      discordClient: client,
      intervalMinutes: options.intervalMinutes || INTERVAL_MINUTES
    });

    return client;
  })().catch((err) => {
    botInitPromise = null;
    botClient = null;
    console.error('[!] Discord bot failed to start:', err.message);
    throw err;
  });

  return botInitPromise;
}

export const startBot = initBot;
export const startDiscordBot = initBot;

/**
 * Cleanly stops the reminder engine loop and destroys the Discord client connection
 */
export async function stopBot() {
  console.log('\n[*] Shutting down Academic Reminder Service...');
  stopReminderEngine();
  await closeDiscordClient();
  botClient = null;
  botInitPromise = null;
}

export const closeBot = stopBot;
export { getDiscordClient, closeDiscordClient, startReminderEngine, stopReminderEngine };

// Direct execution support: running `node src/index.js` delegates to the unified process
const isDirectExecution =
  process.argv[1] &&
  (path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase() ||
   path.resolve(process.argv[1] + '.js').toLowerCase() === fileURLToPath(import.meta.url).toLowerCase());

if (isDirectExecution) {
  const { startServer } = await import('./server.js');
  startServer();
}
