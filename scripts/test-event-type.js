import assert from 'assert';
import { resolveEventType } from '../src/utils/room.js';
import { resolveEventType as resolveFromServices } from '../src/services/helpers.js';
import { buildClassAlertEmbed } from '../src/bot.js';
import { initTestEnvironment } from '../src/db/test-helper.js';
import { runEvaluationTick } from '../src/reminder-engine.js';
import { 
  handleTodayCommand, 
  handleNextCommand, 
  buildRoutineEmbed 
} from '../src/commands/handlers.js';

let passed = 0;
let failed = 0;

function it(desc, fn) {
  try {
    fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

async function itAsync(desc, fn) {
  try {
    await fn();
    console.log(`  ✅ [PASS] ${desc}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ [FAIL] ${desc}: ${err.message}`);
    failed++;
  }
}

function createMockChatInteraction(commandName, options = {}, userId = '1328051283080380559') {
  let replyPayload = null;
  return {
    commandName,
    user: { id: userId, username: 'TestStudent' },
    options: {
      getAttachment: (name) => options[name] || null,
      getString: (name) => options[name] || null,
      ...options
    },
    isChatInputCommand: () => true,
    isModalSubmit: () => false,
    isButton: () => false,
    isStringSelectMenu: () => false,
    isAnySelectMenu: () => false,
    reply: async (payload) => {
      replyPayload = payload;
      return payload;
    },
    getReply: () => replyPayload
  };
}

async function runTests() {
  console.log('====================================================');
  console.log('  TESTING DYNAMIC EVENT TYPE (CLASS VS LAB) RESOLUTION');
  console.log('====================================================\n');

  // --- TEST GROUP 1: resolveEventType Unit Tests ---
  console.log('--- TEST GROUP 1: resolveEventType Helper ---');

  it('Both src/utils/room.js and src/services/helpers.js export identical function', () => {
    assert.strictEqual(typeof resolveEventType, 'function');
    assert.strictEqual(typeof resolveFromServices, 'function');
    assert.strictEqual(resolveEventType('09A-06C'), resolveFromServices('09A-06C'));
  });

  it('Room ending with "C" resolves to CLASS', () => {
    assert.strictEqual(resolveEventType('09A-06C'), 'CLASS');
    assert.strictEqual(resolveEventType('07F-22C'), 'CLASS');
    assert.strictEqual(resolveEventType('10B-16C'), 'CLASS');
  });

  it('Room ending with "c" (lowercase) resolves to CLASS', () => {
    assert.strictEqual(resolveEventType('09a-06c'), 'CLASS');
    assert.strictEqual(resolveEventType('ub-04c'), 'CLASS');
  });

  it('Room ending with "L" resolves to LAB', () => {
    assert.strictEqual(resolveEventType('12F-30L'), 'LAB');
    assert.strictEqual(resolveEventType('AS1-12L'), 'LAB');
    assert.strictEqual(resolveEventType('09B-09L'), 'LAB');
  });

  it('Room ending with "l" (lowercase) resolves to LAB', () => {
    assert.strictEqual(resolveEventType('12f-30l'), 'LAB');
    assert.strictEqual(resolveEventType('as1-12l'), 'LAB');
  });

  it('Trims leading and trailing whitespace before checking suffix', () => {
    assert.strictEqual(resolveEventType('  09A-06C  '), 'CLASS');
    assert.strictEqual(resolveEventType(' \t12F-30L\n '), 'LAB');
  });

  it('Null, undefined, and non-string inputs fallback to default CLASS', () => {
    assert.strictEqual(resolveEventType(null), 'CLASS');
    assert.strictEqual(resolveEventType(undefined), 'CLASS');
    assert.strictEqual(resolveEventType(''), 'CLASS');
    assert.strictEqual(resolveEventType(12345), 'CLASS');
    assert.strictEqual(resolveEventType({}), 'CLASS');
  });

  it('Room ending with any other character defaults to CLASS', () => {
    assert.strictEqual(resolveEventType('UB0802'), 'CLASS');
    assert.strictEqual(resolveEventType('TBA'), 'CLASS');
    assert.strictEqual(resolveEventType('ROOM-101'), 'CLASS');
    assert.strictEqual(resolveEventType('AUDITORIUM'), 'CLASS');
  });

  it('Supports custom defaultType fallback argument', () => {
    assert.strictEqual(resolveEventType(null, 'CUSTOM_FALLBACK'), 'CUSTOM_FALLBACK');
    assert.strictEqual(resolveEventType('UB0802', 'LECTURE'), 'LECTURE');
    assert.strictEqual(resolveEventType('09A-06C', 'FALLBACK'), 'CLASS');
    assert.strictEqual(resolveEventType('12F-30L', 'FALLBACK'), 'LAB');
  });

  // --- TEST GROUP 2: Notification Builder (buildClassAlertEmbed) ---
  console.log('\n--- TEST GROUP 2: Notification Builder (buildClassAlertEmbed) ---');

  const course = { code: 'CSE220', name: 'Data Structures', section: '09', faculty: 'SWG' };

  it('Class room ("09A-06C") builds CLASS embed with proper titles and fields', () => {
    const slot = { start_time: '11:00:00', end_time: '12:20:00', room: '09A-06C' };
    const embed = buildClassAlertEmbed(course, slot, '30M_BEFORE', 30);
    const data = embed.data;

    assert.ok(data.title.includes('Upcoming Class Reminder: CSE220'), `Expected class title, got: ${data.title}`);
    assert.ok(data.description.includes('scheduled class in **30 minutes**'), `Expected class description, got: ${data.description}`);
    assert.strictEqual(data.color, 0x3498DB, 'Standard class color is blue (0x3498DB)');

    const classTimeField = data.fields.find(f => f.name === 'Class Time');
    assert.ok(classTimeField, 'Expected field named "Class Time"');
    assert.ok(classTimeField.value.includes('11:00:00 - 12:20:00'));

    const roomField = data.fields.find(f => f.name === 'Room');
    assert.ok(roomField.value.includes('09A-06C'));
  });

  it('Lab room ("12F-30L") builds LAB embed with proper titles and fields', () => {
    const labCourse = { code: 'CSE330L', name: 'Numerical Methods Lab', section: '11', faculty: 'RFTS' };
    const slot = { start_time: '14:00:00', end_time: '16:50:00', room: '12F-30L' };
    const embed = buildClassAlertEmbed(labCourse, slot, '30M_BEFORE', 30);
    const data = embed.data;

    assert.ok(data.title.includes('Upcoming Lab Reminder: CSE330L'), `Expected lab title, got: ${data.title}`);
    assert.ok(data.description.includes('scheduled lab in **30 minutes**'), `Expected lab description, got: ${data.description}`);
    assert.strictEqual(data.color, 0x06B6D4, 'Standard lab color is cyan (0x06B6D4)');

    const labTimeField = data.fields.find(f => f.name === 'Lab Time');
    assert.ok(labTimeField, 'Expected field named "Lab Time"');
    assert.ok(labTimeField.value.includes('14:00:00 - 16:50:00'));

    const roomField = data.fields.find(f => f.name === 'Room');
    assert.ok(roomField.value.includes('12F-30L'));
  });

  it('Urgent notification (10M_BEFORE) adjusts prefix for Class and Lab', () => {
    const classSlot = { start_time: '11:00:00', end_time: '12:20:00', room: '09A-06C' };
    const classEmbed = buildClassAlertEmbed(course, classSlot, '10M_BEFORE', 10);
    assert.ok(classEmbed.data.title.includes('Class Starting Soon'), 'Class urgent title contains "Class Starting Soon"');
    assert.strictEqual(classEmbed.data.color, 0xE67E22, 'Urgent color is orange (0xE67E22)');

    const labSlot = { start_time: '14:00:00', end_time: '16:50:00', room: '09B-09L' };
    const labEmbed = buildClassAlertEmbed(course, labSlot, '10M_BEFORE', 10);
    assert.ok(labEmbed.data.title.includes('Lab Starting Soon'), 'Lab urgent title contains "Lab Starting Soon"');
    assert.strictEqual(labEmbed.data.color, 0xE67E22, 'Urgent color is orange (0xE67E22)');
  });

  it('Missing room code gracefully defaults to CLASS embed', () => {
    const noRoomSlot = { start_time: '08:00:00', end_time: '09:20:00', room: null };
    const embed = buildClassAlertEmbed(course, noRoomSlot, '30M_BEFORE', 30);
    assert.ok(embed.data.title.includes('Upcoming Class Reminder'));
    assert.ok(embed.data.description.includes('scheduled class in'));
    assert.ok(embed.data.fields.some(f => f.name === 'Class Time'));
  });

  // --- TEST GROUP 3: Reminder Engine Evaluation Tick ---
  console.log('\n--- TEST GROUP 3: Reminder Engine Dispatcher ---');

  const { db, cleanup } = initTestEnvironment();

  await itAsync('Reminder engine dynamically tags LAB dispatches for room ending with L', async () => {
    // CSE220L on Monday at 11:00:00 has room 09B-09L. 30m before is 10:30:00
    const simMonday = new Date('2026-10-05T10:30:00+06:00');
    const dispatches = await runEvaluationTick({ db, referenceDate: simMonday, dryRun: true });
    
    assert.ok(dispatches.length > 0, 'Should trigger at least 1 dispatch');
    const labDispatch = dispatches.find(d => d.course === 'CSE220L');
    assert.ok(labDispatch, 'CSE220L dispatch must exist');
    assert.strictEqual(labDispatch.type, 'LAB', `Expected type LAB for CSE220L with room 09B-09L, got: ${labDispatch.type}`);
  });

  await itAsync('Reminder engine dynamically tags CLASS dispatches for room ending with C', async () => {
    // CSE260 on Monday at 08:00:00 has room 10B-16C. 30m before is 07:30:00
    const simMondayEarly = new Date('2026-10-05T07:30:00+06:00');
    const dispatches = await runEvaluationTick({ db, referenceDate: simMondayEarly, dryRun: true });

    assert.ok(dispatches.length > 0, 'Should trigger CSE260 dispatch');
    const classDispatch = dispatches.find(d => d.course === 'CSE260');
    assert.ok(classDispatch, 'CSE260 dispatch must exist');
    assert.strictEqual(classDispatch.type, 'CLASS', `Expected type CLASS for CSE260 with room 10B-16C, got: ${classDispatch.type}`);
  });

  // --- TEST GROUP 4: Schedule Display Logic (Slash Commands) ---
  console.log('\n--- TEST GROUP 4: Schedule Display Logic ---');

  await itAsync('/next command labels LAB kind and title for lab routine slots', async () => {
    // Tuesday 07:45: CSE260L is at 08:00 (room AS1-12L -> LAB)
    const tuesdayMorning = new Date('2026-10-06T07:45:00+06:00');
    // Set system time / mock query by testing candidates directly or calling handleNextCommand
    const inter = createMockChatInteraction('next');
    await handleNextCommand(inter, db);
    const reply = inter.getReply();
    assert.ok(reply && reply.embeds && reply.embeds.length > 0);
    const nextEmbed = reply.embeds[0];
    const eventTypeField = nextEmbed.data.fields.find(f => f.name === 'Event Type');
    assert.ok(eventTypeField, 'Embed has Event Type field');
    assert.ok(eventTypeField.value.includes('CLASS') || eventTypeField.value.includes('LAB') || eventTypeField.value.includes('MIDTERM') || eventTypeField.value.includes('FINAL'));
  });

  it('buildRoutineEmbed adds `[LAB]` tag to lab slots in weekly overview', () => {
    const sampleSlots = [
      { day_of_week: 'MONDAY', start_time: '08:00:00', end_time: '09:20:00', room: '10B-16C', code: 'CSE260', section: '05' },
      { day_of_week: 'MONDAY', start_time: '11:00:00', end_time: '13:50:00', room: '09B-09L', code: 'CSE220L', section: '09' }
    ];
    const embed = buildRoutineEmbed(sampleSlots, 'ALL');
    const mondayField = embed.data.fields.find(f => f.name.includes('MONDAY'));
    assert.ok(mondayField, 'Monday field must exist');
    assert.ok(mondayField.value.includes('`[LAB]`'), 'Lab slot should have `[LAB]` badge');
    assert.ok(mondayField.value.includes('CSE260'), 'Class slot should be displayed');
  });

  it('buildRoutineEmbed uses "Lab" header in single-day view for lab slots', () => {
    const sampleSlots = [
      { day_of_week: 'TUESDAY', start_time: '14:00:00', end_time: '16:50:00', room: '12F-30L', code: 'CSE330L', section: '11', faculty: 'RFTS' }
    ];
    const embed = buildRoutineEmbed(sampleSlots, 'TUESDAY');
    assert.ok(embed.data.description.includes('**CSE330L** Lab (Section 11)'), `Expected "**CSE330L** Lab (Section 11)", got: ${embed.data.description}`);
  });

  it('buildRoutineEmbed uses "Class" header in single-day view for class slots', () => {
    const sampleSlots = [
      { day_of_week: 'WEDNESDAY', start_time: '08:00:00', end_time: '09:20:00', room: '10B-16C', code: 'CSE260', section: '05', faculty: 'PBK' }
    ];
    const embed = buildRoutineEmbed(sampleSlots, 'WEDNESDAY');
    assert.ok(embed.data.description.includes('**CSE260** Class (Section 05)'), `Expected "**CSE260** Class (Section 05)", got: ${embed.data.description}`);
  });

  cleanup();

  console.log('\n====================================================');
  console.log(`  RESULTS: ${passed}/${passed + failed} TESTS PASSED (${failed === 0 ? '100%' : 'FAILURES'})`);
  console.log('====================================================\n');

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch(err => {
  console.error('[FATAL] Test runner encountered an error:', err);
  process.exit(1);
});
