import { REST, Routes } from 'discord.js';
import 'dotenv/config';
import { slashCommands } from './definitions.js';

export { slashCommands };


/**
 * Registers slash commands with the Discord REST API
 * Supports both global and guild registration
 */
export async function registerCommands(token = process.env.DISCORD_BOT_TOKEN, clientId = null) {
  if (!token) {
    throw new Error('Cannot register slash commands: DISCORD_BOT_TOKEN is missing.');
  }

  const rest = new REST({ version: '10' }).setToken(token);
  const commandsData = slashCommands.map(cmd => cmd.toJSON());

  const targetClientId = clientId || process.env.DISCORD_CLIENT_ID;
  if (!targetClientId) {
    throw new Error('Cannot register slash commands: Target clientId is required.');
  }

  console.log(`[+] Registering ${commandsData.length} slash commands (/start, /link, /today, /next, /deadlines, /addtask, /consultation)...`);

  const response = await rest.put(
    Routes.applicationCommands(targetClientId),
    { body: commandsData }
  );

  console.log(`[+] Successfully registered ${response.length} global slash command(s) with Discord!`);
  return response;
}

// Standalone CLI execution: node src/commands/register.js
if (process.argv[1] && process.argv[1].endsWith('register.js')) {
  (async () => {
    try {
      const token = process.env.DISCORD_BOT_TOKEN;
      let clientId = process.env.DISCORD_CLIENT_ID;

      // If clientId not in .env, fetch from bot's current user account
      if (!clientId && token) {
        const { Client, GatewayIntentBits } = await import('discord.js');
        const tempClient = new Client({ intents: [GatewayIntentBits.Guilds] });
        await tempClient.login(token);
        clientId = tempClient.user.id;
        await tempClient.destroy();
      }

      await registerCommands(token, clientId);
      process.exit(0);
    } catch (err) {
      console.error('[!] Failed to register slash commands:', err.message);
      process.exit(1);
    }
  })();
}
