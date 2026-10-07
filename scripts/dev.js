import 'dotenv/config';
import { startServer } from '../src/server.js';

console.log('====================================================');
console.log('  FRIDAY ACADEMIC ASSISTANT — UNIFIED DEV RUNNER');
console.log('====================================================');

// Start the Unified Server (Web Dashboard + Discord Bot + Reminder Engine)
const port = process.env.PORT || 3000;
startServer(port);
