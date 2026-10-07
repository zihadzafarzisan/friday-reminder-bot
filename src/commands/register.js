import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import 'dotenv/config';

/**
 * Slash command definitions for FRIDAY Academic Assistant (Multi-Tenant)
 */
export const slashCommands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Link your Discord account to FRIDAY and get an import pairing code'),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('View or retrieve your FRIDAY schedule pairing code'),
  new SlashCommandBuilder()
    .setName('today')
    .setDescription("View today's class schedule, room numbers, and timings"),
  new SlashCommandBuilder()
    .setName('next')
    .setDescription('Find your next upcoming class or exam with countdown'),
  new SlashCommandBuilder()
    .setName('deadlines')
    .setDescription('List upcoming quizzes, assignments, midterms, and finals'),
  new SlashCommandBuilder()
    .setName('addtask')
    .setDescription('Add a custom academic deadline, quiz, or assignment'),
  new SlashCommandBuilder()
    .setName('consultation')
    .setDescription('Look up faculty consultation hours and office rooms/links')
    .addStringOption(option =>
      option
        .setName('initial')
        .setDescription('Faculty initial or name to look up (e.g. MSI, TSM)')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('import')
    .setDescription('Import your BRACU course schedule directly by uploading schedule_raw.json')
    .addAttachmentOption(option =>
      option
        .setName('file')
        .setDescription('Upload your schedule_raw.json file')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('routine')
    .setDescription('Interactive weekly class routine viewer with day selector'),
  new SlashCommandBuilder()
    .setName('reset')
    .setDescription('Reset and purge your imported routine, classes, and exams')
];

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
