import { Client, GatewayIntentBits, Partials, EmbedBuilder } from 'discord.js';
import { registerCommands } from './commands/register.js';
import { handleInteraction } from './commands/handlers.js';

let clientInstance = null;

/**
 * Initializes and logs in the Discord Client with minimal required intents
 */
export async function getDiscordClient(token) {
  if (clientInstance && clientInstance.isReady()) {
    return clientInstance;
  }

  const botToken = token || process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    throw new Error('DISCORD_BOT_TOKEN is not defined in environment variables.');
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.DirectMessages
    ],
    partials: [
      Partials.Channel,
      Partials.Message
    ]
  });

  // Attach slash commands interaction handler
  client.on('interactionCreate', async (interaction) => {
    await handleInteraction(interaction);
  });

  await new Promise((resolve, reject) => {
    client.once('clientReady', async () => {
      console.log(`[+] Discord Bot logged in as: ${client.user.tag}`);
      try {
        await registerCommands(botToken, client.user.id);
      } catch (err) {
        console.warn(`[!] Slash commands auto-registration notice: ${err.message}`);
      }
      resolve();
    });
    client.once('error', (err) => {
      reject(err);
    });
    client.login(botToken).catch(reject);
  });

  clientInstance = client;
  return clientInstance;
}

/**
 * Sends a Direct Message (DM) to the target user with error handling
 */
export async function sendDM(userId, messagePayload, client = clientInstance) {
  if (!client || !client.isReady()) {
    throw new Error('Discord client is not ready. Call getDiscordClient() first.');
  }

  try {
    const user = await client.users.fetch(userId);
    if (!user) {
      throw new Error(`Discord user not found for ID: ${userId}`);
    }

    const dmChannel = await user.createDM();
    const sentMessage = await dmChannel.send(messagePayload);
    return { success: true, messageId: sentMessage.id };
  } catch (err) {
    console.error(`[!] Failed to send Discord DM to user ${userId}:`, err.message);
    if (err.code === 50007) {
      console.error('[!] Reason: User has DMs disabled or blocked the bot.');
    }
    return { success: false, error: err.message };
  }
}

/**
 * Formats a clean Rich Embed for upcoming class routines
 */
export function buildClassAlertEmbed(course, slot, offsetType, minutesLeft) {
  const isUrgent = offsetType === '10M_BEFORE';
  const color = isUrgent ? 0xE67E22 : 0x3498DB; // Orange vs Blue

  const titlePrefix = isUrgent ? '⏳ Class Starting Soon' : '🔔 Upcoming Class Reminder';

  return new EmbedBuilder()
    .setTitle(`${titlePrefix}: ${course.code}`)
    .setDescription(`You have a scheduled class in **${minutesLeft} minutes**.`)
    .setColor(color)
    .addFields(
      { name: 'Course', value: `**${course.code}** (Section ${course.section})`, inline: true },
      { name: 'Room', value: `📍 **${slot.room || 'TBA'}**`, inline: true },
      { name: 'Faculty', value: `👨‍🏫 ${course.faculty || 'N/A'}`, inline: true },
      { name: 'Class Time', value: `⏰ **${slot.start_time} - ${slot.end_time}** (BST)`, inline: false }
    )
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka' })
    .setTimestamp();
}

/**
 * Formats a clean Rich Embed for upcoming Exams (Midterm / Final)
 */
export function buildExamAlertEmbed(course, event, offsetType, countdownText) {
  const isFinal = event.type === 'FINAL';
  const color = isFinal ? 0xE74C3C : 0x9B59B6; // Red for Final, Purple for Midterm

  const titlePrefix = isFinal ? '🚨 FINAL EXAM ALERT' : '📝 MIDTERM EXAM ALERT';

  return new EmbedBuilder()
    .setTitle(`${titlePrefix}: ${course.code}`)
    .setDescription(`**${event.title}** takes place in **${countdownText}**!`)
    .setColor(color)
    .addFields(
      { name: 'Course', value: `**${course.code}** (Sec ${course.section})`, inline: true },
      { name: 'Exam Room', value: `📍 **${event.room || 'TBA'}**`, inline: true },
      { name: 'Faculty', value: `👨‍🏫 ${course.faculty || 'N/A'}`, inline: true },
      { name: 'Start Time', value: `🗓️ **${event.start_time}**`, inline: false },
      { name: 'End Time', value: `⏰ **${event.end_time}**`, inline: false }
    )
    .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka' })
    .setTimestamp();
}

/**
 * Formats a clean Rich Embed for custom Academic Deadlines (Quizzes, Assignments, etc.)
 */
export function buildTaskAlertEmbed(course, event, offsetType, countdownText) {
  const isQuiz = event.type === 'QUIZ';
  const color = isQuiz ? 0xF59E0B : 0x06B6D4;
  const typeLabel = isQuiz ? 'QUIZ ALERT' : `${event.type} DEADLINE`;

  const embed = new EmbedBuilder()
    .setTitle(`📌 ${typeLabel}: ${event.title}`)
    .setDescription(`Deadline / event is in **${countdownText}**!`)
    .setColor(color);

  if (course && course.code) {
    embed.addFields(
      { name: 'Course', value: `**${course.code}** (Sec ${course.section || 'N/A'})`, inline: true }
    );
  }

  embed.addFields(
    { name: 'Event Type', value: event.type, inline: true },
    { name: 'Room / Venue', value: `📍 ${event.room || 'Online / TBA'}`, inline: true },
    { name: 'Due / Start Time', value: `⏰ **${event.start_time}** (BST)`, inline: false }
  )
  .setFooter({ text: 'FRIDAY Academic Assistant • Asia/Dhaka' })
  .setTimestamp();

  return embed;
}

/**
 * Formats a test Embed for verification
 */
export function buildTestEmbed(botTag) {
  return new EmbedBuilder()
    .setTitle('✅ FRIDAY Academic Assistant — Connectivity Test')
    .setDescription('Discord bot connection and Direct Message dispatch is working properly!')
    .setColor(0x2ECC71) // Green
    .addFields(
      { name: 'Status', value: '🟢 Online & Ready', inline: true },
      { name: 'Bot Account', value: `@${botTag}`, inline: true },
      { name: 'Timezone', value: 'Asia/Dhaka (UTC+6)', inline: true }
    )
    .setFooter({ text: 'Friday Reminder Bot • Phase 3 Verification' })
    .setTimestamp();
}

/**
 * Destroys the Discord client connection cleanly
 */
export async function closeDiscordClient() {
  if (clientInstance) {
    await clientInstance.destroy();
    clientInstance = null;
  }
}
