import 'dotenv/config';
import { fork } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { startServer } from '../src/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '..');

console.log('====================================================');
console.log('  FRIDAY ACADEMIC ASSISTANT — UNIFIED DEV RUNNER');
console.log('====================================================');

// 1. Start the Web Control Panel
const port = process.env.PORT || 3000;
const server = startServer(port);

// 2. Start the Discord Reminder Bot Engine
console.log('[+] Spawning Discord Reminder Engine in background...');
const botProcess = fork(path.join(ROOT_DIR, 'src', 'index.js'), {
  stdio: 'inherit'
});

const cleanup = () => {
  console.log('\n[*] Stopping unified dev services...');
  botProcess.kill();
  server.close();
  process.exit(0);
};

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
