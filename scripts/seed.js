'use strict';
// Idempotent: safe to run many times. Opening balances go through the real ledger (postMovement).
const bcrypt = require('bcryptjs');
const { pool } = require('../src/db');
const { postMovement } = require('../src/ledger');

const USERS = [
  ['admin@ledgerline.test', 'Admin@12345', 'admin'],
  ['alice@ledgerline.test', 'Alice@12345', 'holder'],
  ['bob@ledgerline.test', 'Bob@12345', 'holder'],
  ['auditor@ledgerline.test', 'Auditor@12345', 'auditor'],
];
(async () => {
  for (const [email, pw, role] of USERS) {
    await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) ON CONFLICT (email) DO NOTHING',
      [email, await bcrypt.hash(pw, 10), role]);
  }
  const u = Object.fromEntries((await pool.query('SELECT id, email, role FROM users')).rows.map((r) => [r.email, r]));
  const admin = u['admin@ledgerline.test'];
  for (const email of ['alice@ledgerline.test', 'bob@ledgerline.test']) {
    let a = (await pool.query('SELECT id FROM accounts WHERE owner_id=$1 ORDER BY id LIMIT 1', [u[email].id])).rows[0];
    if (!a) a = (await pool.query("INSERT INTO accounts (owner_id, name) VALUES ($1,'Main') RETURNING id", [u[email].id])).rows[0];
    await postMovement({ user: admin, type: 'deposit', accountId: a.id, amount: 1000000, key: `seed-open-${u[email].id}` }); // Rs 10,000.00
  }
  console.log('seeded'); await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });
