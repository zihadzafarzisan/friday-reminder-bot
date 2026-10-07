import { SlashCommandBuilder } from 'discord.js';

/**
 * Slash command definitions for FRIDAY Academic Assistant (Multi-Tenant)
 */
export const slashCommands = [
  new SlashCommandBuilder()
    .setName('start')
    .setDescription('Link your Discord account to FRIDAY and get an import pairing code'),
  new SlashCommandBuilder()
    .setName('login')
    .setDescription('Get your one-time passkey and link to access your academic web dashboard.'),
  new SlashCommandBuilder()
    .setName('link')
    .setDescription('Get your one-time passkey and link to access your academic web dashboard.'),
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
