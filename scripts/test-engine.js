import { initTestEnvironment } from '../src/db/test-helper.js';
import { runEvaluationTick, getDhakaContext } from '../src/reminder-engine.js';

console.log('Testing Dhaka Context:');
const ctx = getDhakaContext();
console.log(ctx);

const { db, cleanup } = initTestEnvironment();

// Simulate Monday at 10:30:00 (CSE230 starts at 11:00:00, diff = 30m)
const simDate = new Date('2026-10-05T10:30:00+06:00');
console.log('\n--- Simulation 1: Monday 10:30 AM (dry run) ---');
const res1 = await runEvaluationTick({ db, referenceDate: simDate, dryRun: true });
console.log('Dispatches triggered:', res1);

// Simulate Monday at 10:50:00 (CSE230 starts at 11:00:00, diff = 10m)
const simDate2 = new Date('2026-10-05T10:50:00+06:00');
console.log('\n--- Simulation 2: Monday 10:50 AM (dry run) ---');
const res2 = await runEvaluationTick({ db, referenceDate: simDate2, dryRun: true });
console.log('Dispatches triggered:', res2);

// Simulate Exam 24h before MAT216 (exam is 2026-07-25T08:30:00+06:00, simulate 2026-07-24T08:30:00+06:00)
const simDate3 = new Date('2026-07-24T08:30:00+06:00');
console.log('\n--- Simulation 3: 24h Before MAT216 Midterm (dry run) ---');
const res3 = await runEvaluationTick({ db, referenceDate: simDate3, dryRun: true });
console.log('Dispatches triggered:', res3);

cleanup();
console.log('\nAll simulation tests passed!');
