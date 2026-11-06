'use strict';
require('dotenv').config();
const { Pool, types } = require('pg');
// BIGINT -> JS number. Safe because we cap a single amount at 1e12 paise (see MAX_AMOUNT).
types.setTypeParser(20, (v) => Number(v));

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
pool.on('error', (e) => console.error('pg pool error', e.message));

// Runs fn inside ONE transaction on ONE connection. Any throw => ROLLBACK (nothing persists).
async function withTx(fn, begin = 'BEGIN') {
  const client = await pool.connect();
  try {
    await client.query(begin);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* connection already broken */ }
    throw e;
  } finally {
    client.release();
  }
}
module.exports = { pool, withTx };
