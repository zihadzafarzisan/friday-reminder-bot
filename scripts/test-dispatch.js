import 'dotenv/config';
import { getDiscordClient, sendDM, buildTestEmbed, buildClassAlertEmbed, buildExamAlertEmbed, closeDiscordClient } from '../src/bot.js';

async function main() {
  console.log('====================================================');
  console.log('  BRACU CONNECT — DISCORD DM CONNECTIVITY TEST');
  console.log('====================================================');

  const token = process.env.DISCORD_BOT_TOKEN;
  const userId = process.env.DISCORD_USER_ID;

  if (!token || token === 'your_discord_bot_token_here') {
    console.error('\n[!] Missing DISCORD_BOT_TOKEN in .env file.');
    console.error('Please configure your bot token in .env before running this test.');
    console.error('Example: DISCORD_BOT_TOKEN=MTE5...\n');
    process.exit(1);
  }

  if (!userId || userId === 'your_discord_user_id_here') {
    console.error('\n[!] Missing DISCORD_USER_ID in .env file.');
    console.error('Please configure your personal Discord User ID in .env.');
    console.error('To get your ID: Discord Settings -> Advanced -> Enable Developer Mode -> Right click your profile -> Copy User ID.\n');
    process.exit(1);
  }

  console.log(`[+] Initializing Discord client...`);
  const client = await getDiscordClient(token);
  console.log(`[+] Connected to Discord as: @${client.user.tag}`);

  console.log(`[+] Sending Connectivity Test DM to User ID: ${userId}...`);
  const testEmbed = buildTestEmbed(client.user.tag);
  const testRes = await sendDM(userId, { embeds: [testEmbed] }, client);

  if (!testRes.success) {
    console.error(`\n[!] Test DM failed: ${testRes.error}`);
    console.error('Please verify that:');
    console.error('  1. The user ID is correct.');
    console.error('  2. You share at least one Discord server with the bot.');
    console.error('  3. Direct Messages (DMs) from server members are enabled in your Privacy settings.\n');
    await closeDiscordClient();
    process.exit(1);
  }

  console.log(`[+] Test DM delivered successfully! (Message ID: ${testRes.messageId})`);

  // Send sample Class Reminder Embed
  console.log(`[+] Sending sample Class Reminder DM...`);
  const sampleCourse = { code: 'CSE230', name: 'Discrete Mathematics', section: '05', faculty: 'TSM' };
  const sampleSlot = { start_time: '11:00:00', end_time: '12:20:00', room: '08H-22C' };
  const classEmbed = buildClassAlertEmbed(sampleCourse, sampleSlot, '30M_BEFORE', 30);
  await sendDM(userId, { embeds: [classEmbed] }, client);

  // Send sample Exam Alert Embed
  console.log(`[+] Sending sample Exam Alert DM...`);
  const sampleExam = { type: 'MIDTERM', title: 'CSE230 Midterm Exam', start_time: '2026-07-28 08:30 AM', end_time: '10:30 AM', room: '08H-22C' };
  const examEmbed = buildExamAlertEmbed(sampleCourse, sampleExam, '24H_BEFORE', '24 hours');
  await sendDM(userId, { embeds: [examEmbed] }, client);

  console.log('\n====================================================');
  console.log('  ALL TEST NOTIFICATIONS SENT SUCCESSFULLY!');
  console.log('  Please check your Discord DMs.');
  console.log('====================================================\n');

  await closeDiscordClient();
  process.exit(0);
}

main().catch(async (err) => {
  console.error('\n[FATAL] Connectivity test encountered an unexpected error:');
  console.error(err);
  await closeDiscordClient();
  process.exit(1);
});