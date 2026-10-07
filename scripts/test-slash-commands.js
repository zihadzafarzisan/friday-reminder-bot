import { initTestEnvironment, cleanDatabaseFiles } from '../src/db/test-helper.js';
import { 
  handleTodayCommand, 
  handleNextCommand, 
  handleDeadlinesCommand, 
  handleAddtaskCommand,
  handleTaskModalSubmit,
  handleTaskButton,
  buildAddTaskModal,
  buildTaskActionRow,
  parseDhakaInputToIso,
  handleInteraction 
} from '../src/commands/handlers.js';
import { slashCommands } from '../src/commands/register.js';
import { EmbedBuilder } from 'discord.js';

function createMockChatInteraction(commandName) {
  let replyPayload = null;
  let shownModal = null;
  return {
    commandName,
    user: { id: '1328051283080380559', username: 'TestStudent' },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    deferred: false,
    replied: false,
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    showModal: async (modal) => {
      shownModal = modal;
      return modal;
    },
    getReply: () => replyPayload,
    getModal: () => shownModal
  };
}

function createMockModalSubmitInteraction(fieldsData) {
  let replyPayload = null;
  return {
    customId: 'modal_add_task',
    user: { id: '1328051283080380559', username: 'TestStudent' },
    isChatInputCommand: () => false,
    isModalSubmit: () => true,
    isButton: () => false,
    deferred: false,
    replied: false,
    fields: {
      getTextInputValue: (id) => fieldsData[id] || ''
    },
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    getReply: () => replyPayload
  };
}

function createMockButtonInteraction(customId, originalEmbed) {
  let updatePayload = null;
  return {
    customId,
    user: { id: '1328051283080380559', username: 'TestStudent' },
    message: {
      embeds: [originalEmbed]
    },
    isChatInputCommand: () => false,
    isModalSubmit: () => false,
    isButton: () => true,
    deferred: false,
    replied: false,
    update: async (payload) => {
      updatePayload = payload;
      return payload;
    },
    getUpdate: () => updatePayload
  };
}

async function runSlashCommandTests() {
  console.log('====================================================');
  console.log('  TESTING DISCORD COMMANDS, MODALS & BUTTONS');
  console.log('====================================================\n');

  const { db, cleanup } = initTestEnvironment();
  let passed = 0;
  let total = 0;

  function assert(condition, testName) {
    total++;
    if (condition) {
      console.log(`  ✅ [PASS] ${testName}`);
      passed++;
    } else {
      console.error(`  ❌ [FAIL] ${testName}`);
    }
  }

  // 1. Check command definitions
  console.log('--- TEST GROUP 1: Slash Command Definitions ---');
  const commandNames = slashCommands.map(c => c.name);
  assert(commandNames.includes('today'), 'slashCommands includes /today');
  assert(commandNames.includes('next'), 'slashCommands includes /next');
  assert(commandNames.includes('deadlines'), 'slashCommands includes /deadlines');
  assert(commandNames.includes('addtask'), 'slashCommands includes /addtask');

  // 2. Test /today command handler
  console.log('\n--- TEST GROUP 2: /today Command Handler ---');
  const todayInteraction = createMockChatInteraction('today');
  await handleTodayCommand(todayInteraction, db);
  const todayReply = todayInteraction.getReply();
  assert(todayReply !== null && todayReply.embeds && todayReply.embeds.length > 0, '/today returns an Embed');
  const todayEmbed = todayReply.embeds[0];
  assert(todayEmbed.data.title.includes("Today's Schedule"), '/today title includes "Today\'s Schedule"');
  assert(todayEmbed.data.footer.text.includes('Asia/Dhaka'), '/today footer explicitly specifies Asia/Dhaka (+06:00)');

  // 3. Test /next command handler
  console.log('\n--- TEST GROUP 3: /next Command Handler ---');
  const nextInteraction = createMockChatInteraction('next');
  await handleNextCommand(nextInteraction, db);
  const nextReply = nextInteraction.getReply();
  assert(nextReply !== null && nextReply.embeds && nextReply.embeds.length > 0, '/next returns an Embed');
  const nextEmbed = nextReply.embeds[0];
  assert(nextEmbed.data.title.startsWith('⏳ Next Up:') || nextEmbed.data.title.includes('Next'), '/next title is properly formatted');
  assert(nextEmbed.data.description.includes('<t:'), '/next description contains dynamic Discord timestamp countdown (<t:TIMESTAMP:R>)');

  // 4. Test /deadlines command handler
  console.log('\n--- TEST GROUP 4: /deadlines Command Handler ---');
  const deadlinesInteraction = createMockChatInteraction('deadlines');
  await handleDeadlinesCommand(deadlinesInteraction, db);
  const deadlinesReply = deadlinesInteraction.getReply();
  assert(deadlinesReply !== null && deadlinesReply.embeds && deadlinesReply.embeds.length > 0, '/deadlines returns an Embed');
  const deadlinesEmbed = deadlinesReply.embeds[0];
  assert(deadlinesEmbed.data.title.includes('Upcoming Academic Deadlines'), '/deadlines title is properly formatted');

  // 5. Test /addtask Modal Builder & Command
  console.log('\n--- TEST GROUP 5: /addtask Modal Builder ---');
  const modal = buildAddTaskModal();
  assert(modal.data.custom_id === 'modal_add_task', 'Modal custom_id is "modal_add_task"');
  assert(modal.components.length === 5, 'Modal has 5 text input components');

  const addtaskInteraction = createMockChatInteraction('addtask');
  await handleAddtaskCommand(addtaskInteraction);
  assert(addtaskInteraction.getModal() !== null, '/addtask triggers interaction.showModal()');

  // 6. Test Dhaka Date Parser
  console.log('\n--- TEST GROUP 6: parseDhakaInputToIso Parser ---');
  const parsed1 = parseDhakaInputToIso('2026-10-06 14:30');
  assert(parsed1 === '2026-10-06T14:30:00+06:00', 'parseDhakaInputToIso("2026-10-06 14:30") -> 2026-10-06T14:30:00+06:00');
  const parsed2 = parseDhakaInputToIso('2026/10/06 9:15');
  assert(parsed2 === '2026-10-06T09:15:00+06:00', 'parseDhakaInputToIso("2026/10/06 9:15") pads hour correctly');
  const parsedInvalid = parseDhakaInputToIso('not-a-date');
  assert(parsedInvalid === null, 'parseDhakaInputToIso rejects malformed inputs');

  // 7. Test Modal Submission Handler
  console.log('\n--- TEST GROUP 7: handleTaskModalSubmit ---');
  const modalSubmitInteraction = createMockModalSubmitInteraction({
    task_course: 'CSE230',
    task_type: 'QUIZ',
    task_title: 'Quiz 3: Pipelining Hazards',
    task_datetime: '2026-10-10 11:00',
    task_room: '08H-22C'
  });
  await handleTaskModalSubmit(modalSubmitInteraction, db);
  const modalReply = modalSubmitInteraction.getReply();
  assert(modalReply !== null && modalReply.embeds && modalReply.embeds.length > 0, 'Modal submit responds with Embed');
  const createdEmbed = modalReply.embeds[0];
  assert(createdEmbed.data.title.includes('Quiz 3: Pipelining Hazards'), 'Created embed displays task title');

  // Verify task was inserted into DB
  const insertedEvent = db.prepare(`SELECT * FROM events WHERE title = 'Quiz 3: Pipelining Hazards'`).get();
  assert(insertedEvent !== undefined, 'Task successfully saved in academic.db events table');
  assert(insertedEvent.is_custom === 1, 'Task has is_custom: 1');
  assert(insertedEvent.start_time === '2026-10-10T11:00:00+06:00', 'Task has correct Asia/Dhaka ISO timestamp (+06:00)');
  assert(insertedEvent.room === '08H-22C', 'Task has correct room assigned');

  // 8. Test ActionRow & Button Builder
  console.log('\n--- TEST GROUP 8: buildTaskActionRow & Mark Completed Button ---');
  const actionRow = buildTaskActionRow(insertedEvent.id);
  assert(actionRow.components.length === 1, 'ActionRow contains 1 button');
  const button = actionRow.components[0];
  assert(button.data.custom_id === `complete_task_${insertedEvent.id}`, `Button custom_id is complete_task_${insertedEvent.id}`);
  assert(button.data.label === 'Mark Completed', 'Button label is "Mark Completed"');

  // 9. Test Button Click Handler
  console.log('\n--- TEST GROUP 9: handleTaskButton Click Execution ---');
  const testEmbedOriginal = new EmbedBuilder()
    .setTitle('📌 QUIZ REMINDER: Quiz 3: Pipelining Hazards')
    .setDescription('Due soon!');
  const buttonInteraction = createMockButtonInteraction(`complete_task_${insertedEvent.id}`, testEmbedOriginal);
  await handleTaskButton(buttonInteraction, db);
  const updatePayload = buttonInteraction.getUpdate();
  assert(updatePayload !== null, 'handleTaskButton called interaction.update()');
  assert(updatePayload.content.includes('marked as completed'), 'Update content confirms completion');

  // Verify event was deleted from events table
  const checkDeleted = db.prepare('SELECT id FROM events WHERE id = ?').get(insertedEvent.id);
  assert(!checkDeleted, 'Completed task removed from active events table');

  // Verify suppression logged in notification_logs
  const checkLogs = db.prepare(`SELECT * FROM notification_logs WHERE event_id = ? AND status = 'COMPLETED'`).all(String(insertedEvent.id));
  assert(checkLogs.length > 0, 'Notification suppression entries logged in notification_logs');

  // 10. Test Router Integration
  console.log('\n--- TEST GROUP 10: handleInteraction Universal Router ---');
  const routerAddtask = createMockChatInteraction('addtask');
  await handleInteraction(routerAddtask, db);
  assert(routerAddtask.getModal() !== null, 'Router correctly handles /addtask');

  const routerModal = createMockModalSubmitInteraction({
    task_course: 'HUM101',
    task_type: 'ASSIGNMENT',
    task_title: 'Router Test Essay',
    task_datetime: '2026-10-12 23:59',
    task_room: 'Online Portal'
  });
  await handleInteraction(routerModal, db);
  assert(routerModal.getReply() !== null, 'Router correctly handles modal_add_task submission');

  // Clean up router test event
  const routerEv = db.prepare(`SELECT id FROM events WHERE title = 'Router Test Essay'`).get();
  if (routerEv) {
    db.prepare('DELETE FROM events WHERE id = ?').run(routerEv.id);
  }

  console.log(`\n====================================================`);
  console.log(`  RESULTS: ${passed}/${total} TESTS PASSED (${Math.round((passed/total)*100)}%)`);
  console.log(`====================================================`);

  cleanup();

  if (passed === total) {
    process.exit(0);
  } else {
    process.exit(1);
  }
}

runSlashCommandTests().catch(err => {
  console.error('[FATAL] Command & Modal test runner failed:', err);
  try {
    cleanDatabaseFiles(process.env.DB_PATH);
  } catch {}
  process.exit(1);
});
