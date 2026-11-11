'use strict';
require('dotenv').config();
const app = require('./app');
const { pool } = require('./db');
let databaseUrlValid = false;
try {
  const databaseUrl = new URL(process.env.DATABASE_URL || '');
  databaseUrlValid = ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) && Boolean(databaseUrl.hostname);
} catch { /* invalid database URL is handled by the startup check below */ }
if (!process.env.JWT_SECRET || Buffer.byteLength(process.env.JWT_SECRET, 'utf8') < 32 || !databaseUrlValid) {
  console.error(JSON.stringify({ level: 'error', event: 'startup.configuration_invalid', required: ['DATABASE_URL', 'JWT_SECRET'] }));
  process.exit(1);
}
const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(JSON.stringify({ level: 'error', event: 'startup.configuration_invalid', field: 'PORT' }));
  process.exit(1);
}
const server = app.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ level: 'info', event: 'server.started', port })));
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ level: 'info', event: 'server.shutdown', signal }));
  server.close(async (error) => {
    if (error) console.error(JSON.stringify({ level: 'error', event: 'server.close_failed', code: error.code || 'SERVER_ERROR' }));
    await pool.end();
    process.exitCode = error ? 1 : 0;
  });
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
