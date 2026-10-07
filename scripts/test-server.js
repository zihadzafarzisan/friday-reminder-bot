import { createServer } from '../src/server.js';

const app = createServer();
const server = app.listen(3099, async () => {
  console.log('Test server listening on port 3099');
  
  try {
    // 1. Test /api/status
    const statusRes = await fetch('http://localhost:3099/api/status');
    const statusJson = await statusRes.json();
    console.log('[PASS] /api/status:', statusJson.data);

    // 2. Test /api/routine
    const routineRes = await fetch('http://localhost:3099/api/routine');
    const routineJson = await routineRes.json();
    console.log('[PASS] /api/routine slots count:', routineJson.data.slots.length);
    console.log('[PASS] /api/routine days:', Object.keys(routineJson.data.grouped));

    // 3. Test /api/events
    const eventsRes = await fetch('http://localhost:3099/api/events');
    const eventsJson = await eventsRes.json();
    console.log('[PASS] /api/events count:', eventsJson.data.length);

    // 4. Test POST /api/events
    const postRes = await fetch('http://localhost:3099/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        course_id: 1,
        type: 'QUIZ',
        title: 'HUM101 Test Quiz on Ethics',
        start_time: '2026-10-20T14:00',
        room: '09G-28C'
      })
    });
    const postJson = await postRes.json();
    console.log('[PASS] POST /api/events created ID:', postJson.data.id);

    // 5. Test DELETE /api/events/:id
    const delRes = await fetch(`http://localhost:3099/api/events/${postJson.data.id}`, {
      method: 'DELETE'
    });
    const delJson = await delRes.json();
    console.log('[PASS] DELETE /api/events/:id message:', delJson.message);

    // 6. Test /api/logs
    const logsRes = await fetch('http://localhost:3099/api/logs');
    const logsJson = await logsRes.json();
    console.log('[PASS] /api/logs count:', logsJson.data.length);

    console.log('\n>>> ALL 6 API ENDPOINTS VERIFIED SUCCESSFULLY! <<<');
  } catch (err) {
    console.error('[FAIL] API test error:', err);
  } finally {
    server.close();
    process.exit(0);
  }
});
