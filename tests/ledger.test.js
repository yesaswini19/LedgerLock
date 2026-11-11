'use strict';
// These tests write fixtures and transactions, so they require the isolated local test database.
require('dotenv').config();
const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl || !testDatabaseUrl.trim()) {
  throw new Error('TEST_DATABASE_URL is required; refusing to run tests without the isolated test database.');
}

let testDatabase;
try {
  testDatabase = new URL(testDatabaseUrl);
} catch {
  throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL URL for local ledgerline_test.');
}
const localHosts = ['localhost', '127.0.0.1', '::1', '[::1]'];
const hostOverrides = testDatabase.searchParams.getAll('host');
const hasRemoteHostOverride = hostOverrides.some((host) => !localHosts.includes(host.toLowerCase())) ||
  testDatabase.searchParams.has('hostaddr');
let testDatabaseName;
try {
  testDatabaseName = decodeURIComponent(testDatabase.pathname.replace(/^\//, ''));
} catch {
  throw new Error('TEST_DATABASE_URL must identify local PostgreSQL database ledgerline_test.');
}
if (!['postgres:', 'postgresql:'].includes(testDatabase.protocol) ||
    !localHosts.includes(testDatabase.hostname.toLowerCase()) ||
    hasRemoteHostOverride ||
    testDatabaseName !== 'ledgerline_test') {
  throw new Error('TEST_DATABASE_URL must target local PostgreSQL database ledgerline_test; refusing to run tests.');
}

process.env.DATABASE_URL = testDatabaseUrl;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('events');
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const app = require('../src/app');
const { pool } = require('../src/db');
const { signToken } = require('../src/auth');

const uid = () => crypto.randomUUID();
let server;
let api;
const hash = bcrypt.hashSync('x', 4);

async function mkUser(role) {
  const r = await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id, email, role',
    [`${role}-${uid()}@t.test`, hash, role]);
  return { ...r.rows[0], token: signToken(r.rows[0]) };
}
async function mkAccount(owner) {
  return (await pool.query("INSERT INTO accounts (owner_id, name) VALUES ($1,'T') RETURNING id", [owner.id])).rows[0].id;
}
const post = (u, url, body, key = uid()) => api.post(url).set('Authorization', `Bearer ${u.token}`).set('Idempotency-Key', key).send(body);
const balance = async (id) => (await pool.query('SELECT balance FROM accounts WHERE id=$1', [id])).rows[0].balance;
const globalSum = async () => Number((await pool.query('SELECT COALESCE(SUM(balance),0) s FROM accounts')).rows[0].s);
let admin;
const fund = async (acct, amt) => { const r = await post(admin, `/accounts/${acct}/deposit`, { amount: amt }); assert.equal(r.status, 201); };

after(async () => {
  try {
    if (server?.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  } finally {
    await pool.end();
  }
});

test('setup', async () => {
  server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  api = request(server);
  admin = await mkUser('admin');
});

test('REGISTRATION and ADMIN: public signup is holder-only; admin data and audit are role protected', async () => {
  const health = await api.get('/health');
  assert.equal(health.status, 200);
  assert.equal(health.headers['x-content-type-options'], 'nosniff');
  assert.equal(health.headers['x-frame-options'], 'DENY');
  assert.equal(health.headers['referrer-policy'], 'strict-origin-when-cross-origin');
  assert.equal(health.headers['permissions-policy'], 'camera=(), microphone=(), geolocation=()');
  assert.match(health.headers['content-security-policy'], /default-src 'self'/);
  assert.match(health.headers['content-security-policy'], /object-src 'none'/);
  assert.equal(health.headers['x-powered-by'], undefined);
  assert.equal((await api.get('/signin')).status, 200);
  assert.equal((await api.get('/register')).status, 200);
  assert.equal((await api.get('/admin')).status, 200);
  assert.equal((await api.get('/auditor')).status, 200);
  const email = `register-${uid()}@t.test`;
  const fullName = 'Registration Test User';
  const password = 'Registration-Pass-123';
  const registered = await api.post('/auth/register').send({ fullName, email, password, role: 'admin', is_active: false });
  assert.equal(registered.status, 201);
  assert.equal(registered.body.user.role, 'holder');
  assert.equal(registered.body.user.fullName, fullName);
  assert.equal('token' in registered.body, false, 'registration does not sign the user in');
  const stored = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [registered.body.user.id])).rows[0];
  assert.equal(await bcrypt.compare(password, stored.password_hash), true);
  assert.equal((await api.post('/auth/register').send({ fullName: 'Duplicate User', email, password })).status, 409);
  assert.equal((await api.post('/auth/register').send({ email: `missing-name-${uid()}@t.test`, password })).status, 400);
  assert.equal((await api.post('/auth/register').send({ fullName: '   ', email: `blank-name-${uid()}@t.test`, password })).status, 400);
  assert.equal((await api.post('/auth/login').send({ email, password: 'incorrect-password' })).status, 401);
  const login = await api.post('/auth/login').send({ email, password });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.fullName, fullName);
  const auth = `Bearer ${login.body.token}`;
  assert.equal((await api.get('/me').set('Authorization', auth)).body.role, 'holder');
  assert.equal((await api.get('/me').set('Authorization', auth)).body.fullName, fullName);
  const opened = await api.post('/accounts').set('Authorization', auth).send({ name: 'Onboarding account' });
  assert.equal(opened.status, 201);
  assert.equal(opened.body.ownerId, registered.body.user.id);
  const expired = jwt.sign({ sub: String(registered.body.user.id) }, process.env.JWT_SECRET, { expiresIn: -1 });
  assert.equal((await api.get('/me').set('Authorization', `Bearer ${expired}`)).status, 401);
  assert.equal((await api.get('/me').set('Authorization', 'Bearer invalid-token')).status, 401);
  assert.equal((await api.get('/admin/users')).status, 401);
  assert.equal((await api.get('/admin/users').set('Authorization', `Bearer ${login.body.token}`)).status, 403);
  assert.equal((await api.get('/admin/audit-events').set('Authorization', `Bearer ${login.body.token}`)).status, 403);
  assert.equal((await api.post('/admin/users').send({ email: `noauth-${uid()}@t.test`, password: 'Long-Enough-Demo-Password-123', role: 'admin' })).status, 401);
  assert.equal((await api.patch(`/admin/users/${registered.body.user.id}/status`).set('Authorization', auth).send({ active: false })).status, 403);
  const listing = await api.get('/admin/users').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(listing.status, 200);
  assert.ok(listing.body.some((user) => user.email === email && user.fullName === fullName && user.status === 'active'));
  const events = await api.get('/admin/audit-events').set('Authorization', `Bearer ${admin.token}`);
  assert.equal(events.status, 200);
  assert.ok(events.body.some((event) => event.action === 'auth.register.completed' && event.targetId === String(registered.body.user.id)));
  assert.ok(events.body.some((event) => event.action === 'account.created' && event.targetId === String(opened.body.id)));
  const managedEmail = `managed-${uid()}@t.test`;
  const managed = await api.post('/admin/users').set('Authorization', `Bearer ${admin.token}`).send({ email: managedEmail, password: 'Long-Enough-Demo-Password-123', role: 'holder' });
  assert.equal(managed.status, 201);
  assert.equal(managed.body.role, 'holder');
  assert.equal((await api.patch(`/admin/users/${admin.id}/status`).set('Authorization', `Bearer ${admin.token}`).send({ active: false })).status, 422);
  const disable = await api.patch(`/admin/users/${registered.body.user.id}/status`).set('Authorization', `Bearer ${admin.token}`).send({ active: false });
  assert.equal(disable.status, 200);
  assert.equal((await api.get('/me').set('Authorization', `Bearer ${login.body.token}`)).status, 401);
});

test('CONSERVATION: random concurrent transfers never change the total; ledger balances', async () => {
  const users = await Promise.all([1, 2, 3, 4].map(() => mkUser('holder')));
  const accts = await Promise.all(users.map(mkAccount));
  for (const a of accts) await fund(a, 10000);
  const before = await globalSum();
  const jobs = [];
  for (let i = 0; i < 60; i++) {
    const f = Math.floor(Math.random() * 4);
    let t = Math.floor(Math.random() * 4); if (t === f) t = (t + 1) % 4;
    jobs.push(post(users[f], '/transfers', { fromAccountId: accts[f], toAccountId: accts[t], amount: 1 + Math.floor(Math.random() * 3000) }));
  }
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => [201, 422].includes(r.status)), 'MUTATION_CHECK:ROW_LOCK: transfer statuses are valid: ' + res.map((r) => r.status));
  const total = (await Promise.all(accts.map(balance))).reduce((a, b) => a + b, 0);
  assert.equal(total, 40000, 'MUTATION_CHECK:ROW_LOCK: customer balances are conserved');
  for (const a of accts) assert.ok((await balance(a)) >= 0);
  assert.equal(await globalSum(), before, 'MUTATION_CHECK:ROW_LOCK: global sum is conserved');
  assert.equal(before, 0, 'sum of ALL balances (incl. EXTERNAL) is 0');
});

test('NO DOUBLE-SPEND: 20 concurrent withdrawals against a balance that covers 5', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u);
  await fund(a, 500);
  const res = await Promise.all(Array.from({ length: 20 }, () => post(u, `/accounts/${a}/withdraw`, { amount: 100 })));
  const ok = res.filter((r) => r.status === 201).length;
  const refused = res.filter((r) => r.status === 422 && r.body.error.code === 'INSUFFICIENT_FUNDS').length;
  assert.equal(ok, 5, 'MUTATION_CHECK:WITHDRAWALS: exactly five succeed');
  assert.equal(refused, 15, 'MUTATION_CHECK:WITHDRAWALS: exactly fifteen are refused: ' + res.map((r) => r.status));
  assert.equal(await balance(a), 0, 'MUTATION_CHECK:WITHDRAWALS: source balance is zero');
});

test('NO DOUBLE-SPEND via transfers: 20 concurrent transfers out of one account', async () => {
  const u = await mkUser('holder'); const v = await mkUser('holder');
  const a = await mkAccount(u); const b = await mkAccount(v);
  await fund(a, 300);
  const res = await Promise.all(Array.from({ length: 20 }, () => post(u, '/transfers', { fromAccountId: a, toAccountId: b, amount: 100 })));
  assert.equal(res.filter((r) => r.status === 201).length, 3, 'MUTATION_CHECK:TRANSFERS: exactly three succeed');
  assert.equal(res.filter((r) => r.status === 422).length, 17, 'MUTATION_CHECK:TRANSFERS: exactly seventeen are refused');
  assert.equal(await balance(a), 0, 'MUTATION_CHECK:TRANSFERS: source balance is zero');
  assert.equal(await balance(b), 300, 'MUTATION_CHECK:TRANSFERS: destination balance is conserved');
});

test('NO DEADLOCK: opposite-direction transfers racing', async () => {
  const u = await mkUser('holder'); const v = await mkUser('holder');
  const a = await mkAccount(u); const b = await mkAccount(v);
  await fund(a, 5000); await fund(b, 5000);
  const jobs = [];
  for (let i = 0; i < 25; i++) {
    jobs.push(post(u, '/transfers', { fromAccountId: a, toAccountId: b, amount: 10 }));
    jobs.push(post(v, '/transfers', { fromAccountId: b, toAccountId: a, amount: 10 }));
  }
  const res = await Promise.all(jobs);
  assert.ok(res.every((r) => r.status === 201), 'MUTATION_CHECK:ROW_LOCK: opposite transfers all complete: ' + [...new Set(res.map((r) => r.status))]);
  assert.equal((await balance(a)) + (await balance(b)), 10000, 'MUTATION_CHECK:ROW_LOCK: opposite transfer balances are conserved');
});

test('IDEMPOTENCY: replaying a key (sequential) moves money once and returns the same answer', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 1000);
  const key = uid();
  const r1 = await post(u, `/accounts/${a}/withdraw`, { amount: 400 }, key);
  const r2 = await post(u, `/accounts/${a}/withdraw`, { amount: 400 }, key);
  assert.equal(r1.status, 201);
  assert.equal(r2.status, 201, 'MUTATION_CHECK:IDEMPOTENCY: sequential replay succeeds');
  assert.deepEqual(r2.body, r1.body);
  assert.equal(r1.headers['idempotent-replay'], 'false'); assert.equal(r2.headers['idempotent-replay'], 'true');
  assert.equal(await balance(a), 600);
  const n = (await pool.query("SELECT count(*)::int c FROM transactions WHERE initiated_by=$1 AND type='withdrawal'", [u.id])).rows[0].c;
  assert.equal(n, 1, 'MUTATION_CHECK:IDEMPOTENCY: sequential replay posts one transaction');
  const dup = (await pool.query("SELECT count(*)::int c FROM attempts WHERE user_id=$1 AND idempotency_key=$2 AND outcome='replayed'", [u.id, key])).rows[0].c;
  assert.equal(dup, 1, 'the duplicate is visible in the data');
});

test('IDEMPOTENCY: 10 identical requests fired at once (retry while first in flight) pay once', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 1000);
  const key = uid();
  const res = await Promise.all(Array.from({ length: 10 }, () => post(u, `/accounts/${a}/withdraw`, { amount: 300 }, key)));
  assert.ok(res.every((r) => r.status === 201), 'MUTATION_CHECK:IDEMPOTENCY: concurrent replays succeed: ' + res.map((r) => r.status).join());
  assert.equal(new Set(res.map((r) => r.body.transactionId)).size, 1, 'MUTATION_CHECK:IDEMPOTENCY: concurrent requests share one transaction');
  assert.equal(res.filter((r) => r.headers['idempotent-replay'] === 'false').length, 1, 'MUTATION_CHECK:IDEMPOTENCY: one request claims the key');
  assert.equal(await balance(a), 700, 'MUTATION_CHECK:IDEMPOTENCY: concurrent replay moves money once');
});

test('IDEMPOTENCY: same key, different body is rejected (422) and moves nothing', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 1000);
  const key = uid();
  assert.equal((await post(u, `/accounts/${a}/withdraw`, { amount: 100 }, key)).status, 201);
  const r = await post(u, `/accounts/${a}/withdraw`, { amount: 999 }, key);
  assert.equal(r.status, 422, 'MUTATION_CHECK:IDEMPOTENCY: changed request is rejected');
  assert.equal(r.body.error.code, 'IDEMPOTENCY_KEY_REUSED', 'MUTATION_CHECK:IDEMPOTENCY: changed request gets the key-reused error');
  assert.equal(await balance(a), 900);
});

test('IDEMPOTENCY: a missing key is rejected', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u);
  const r = await api.post(`/accounts/${a}/withdraw`).set('Authorization', `Bearer ${u.token}`).send({ amount: 1 });
  assert.equal(r.status, 400);
});

test('AUTHORISATION: a user cannot move another user\'s money', async () => {
  const alice = await mkUser('holder'); const mallory = await mkUser('holder');
  const a = await mkAccount(alice); const m = await mkAccount(mallory);
  await fund(a, 1000);
  const t = await post(mallory, '/transfers', { fromAccountId: a, toAccountId: m, amount: 500 });
  assert.equal(t.status, 403, 'MUTATION_CHECK:OWNERSHIP: cross-owner transfer is rejected');
  assert.equal(t.body.error.code, 'NOT_YOUR_ACCOUNT', 'MUTATION_CHECK:OWNERSHIP: transfer rejection is ownership-based');
  assert.equal((await post(mallory, `/accounts/${a}/withdraw`, { amount: 500 })).status, 403, 'MUTATION_CHECK:OWNERSHIP: cross-owner withdrawal is rejected');
  assert.equal((await api.get(`/accounts/${a}`).set('Authorization', `Bearer ${mallory.token}`)).status, 403);
  assert.equal((await api.get(`/accounts/${a}/statement`).set('Authorization', `Bearer ${mallory.token}`)).status, 403);
  assert.equal(await balance(a), 1000); assert.equal(await balance(m), 0);
});

test('AUTHORISATION: roles - holder cannot deposit, auditor cannot move money, admin cannot spend holder money', async () => {
  const h = await mkUser('holder'); const aud = await mkUser('auditor'); const a = await mkAccount(h); await fund(a, 1000);
  assert.equal((await post(h, `/accounts/${a}/deposit`, { amount: 500 })).status, 403, 'MUTATION_CHECK:ROLE: holder cannot deposit');
  assert.equal((await post(aud, `/accounts/${a}/withdraw`, { amount: 500 })).status, 403);
  assert.equal((await post(aud, `/accounts/${a}/deposit`, { amount: 500 })).status, 403, 'MUTATION_CHECK:ROLE: auditor cannot deposit');
  assert.equal((await post(admin, `/accounts/${a}/withdraw`, { amount: 500 })).status, 403);
  assert.equal((await post(admin, '/transfers', { fromAccountId: a, toAccountId: a + 99999, amount: 5 })).status, 403);
  assert.equal((await api.post(`/accounts/${a}/withdraw`).send({ amount: 1 })).status, 401, 'no token');
  assert.equal(await balance(a), 1000);
});

test('VALIDATION: bad amounts and accounts never move money', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 1000);
  for (const amount of [0, -5, 1.5, '100', null, 1e13]) assert.equal((await post(u, `/accounts/${a}/withdraw`, { amount })).status, 400, String(amount));
  assert.equal((await post(u, '/transfers', { fromAccountId: a, toAccountId: a, amount: 5 })).status, 400);
  assert.equal((await post(u, '/transfers', { fromAccountId: a, toAccountId: 987654321, amount: 5 })).status, 404);
  assert.equal(await balance(a), 1000);
});

test('REFUSED attempts are recorded and appear on the statement; failure leaves no partial postings', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 100);
  const r = await post(u, `/accounts/${a}/withdraw`, { amount: 500 });
  assert.equal(r.status, 422);
  const st = await api.get(`/accounts/${a}/statement`).set('Authorization', `Bearer ${u.token}`);
  const refused = st.body.items.filter((i) => i.kind === 'refused');
  assert.equal(refused.length, 1); assert.equal(refused[0].reason, 'INSUFFICIENT_FUNDS');
  const postings = st.body.items.filter((i) => i.kind === 'posting');
  assert.equal(postings.length, 1); assert.equal(postings[0].balanceAfter, 100);
});

test('APPEND-ONLY: ledger rows cannot be updated, deleted or truncated (even by the app DB user)', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u); await fund(a, 100);
  const movementEvent = (await pool.query("SELECT id FROM audit_events WHERE action='money.deposit' ORDER BY id DESC LIMIT 1")).rows[0];
  assert.ok(movementEvent, 'successful movement is written to audit events');
  await assert.rejects(pool.query('UPDATE ledger_entries SET amount = 1 WHERE account_id = $1', [a]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM ledger_entries WHERE account_id = $1', [a]), /append-only/);
  await assert.rejects(pool.query('UPDATE transactions SET amount = 1 WHERE to_account_id = $1', [a]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM attempts'), /append-only/);
  await assert.rejects(pool.query('TRUNCATE ledger_entries CASCADE'), /append-only/);
  const audit = (await pool.query('SELECT id FROM audit_events ORDER BY id DESC LIMIT 1')).rows[0];
  assert.ok(audit);
  await assert.rejects(pool.query('UPDATE audit_events SET action = $1 WHERE id = $2', ['changed', audit.id]), /append-only/);
  await assert.rejects(pool.query('DELETE FROM audit_events WHERE id = $1', [audit.id]), /append-only/);
  await assert.rejects(pool.query('TRUNCATE audit_events'), /append-only/);
});

test('DB BACKSTOP: the database itself refuses a negative customer balance', async () => {
  const u = await mkUser('holder'); const a = await mkAccount(u);
  await assert.rejects(pool.query('UPDATE accounts SET balance = -1 WHERE id = $1', [a]), /no_negative_balance/);
});

test('TAMPER-EVIDENCE: verify is clean, then detects a row altered by someone who bypassed the trigger', async () => {
  const aud = await mkUser('auditor');
  const get = () => api.get('/audit/verify').set('Authorization', `Bearer ${aud.token}`);
  const clean = await get();
  assert.equal(clean.status, 200); assert.equal(clean.body.ok, true, JSON.stringify(clean.body.problems));
  assert.equal(clean.body.sumOfAllBalances, 0);
  const h = await mkUser('holder'); const a = await mkAccount(h); await fund(a, 777);
  assert.equal((await api.get('/audit/verify').set('Authorization', `Bearer ${h.token}`)).status, 403);
  const row = (await pool.query("SELECT id, amount FROM ledger_entries WHERE account_id=$1 AND direction='credit'", [a])).rows[0];
  const T = 'ledger_entries_no_mutate';
  let triggerDisabled = false;
  let testError;
  let restoreError;
  let enableError;
  try {   // simulate a DB owner switching the trigger off and editing history
    triggerDisabled = true;
    await pool.query(`ALTER TABLE ledger_entries DISABLE TRIGGER ${T}`);
    await pool.query('UPDATE ledger_entries SET amount = 1 WHERE id = $1', [row.id]);
    const bad = await get();
    assert.equal(bad.body.ok, false);
    assert.ok(bad.body.problems.some((p) => p.includes(`entry ${row.id}`)), 'names the altered row');
  } catch (error) {
    testError = error;
  } finally {
    if (triggerDisabled) {
      try {
        await pool.query('UPDATE ledger_entries SET amount = $2 WHERE id = $1', [row.id, row.amount]);
      } catch (error) {
        restoreError = error;
      } finally {
        try {
          await pool.query(`ALTER TABLE ledger_entries ENABLE TRIGGER ${T}`);
        } catch (error) {
          enableError = error;
        }
      }
    }
  }
  const cleanupErrors = [restoreError, enableError].filter(Boolean);
  if (cleanupErrors.length) {
    const errors = testError ? [testError, ...cleanupErrors] : cleanupErrors;
    throw new AggregateError(errors, `Tamper test cleanup failed: ${cleanupErrors.map((error) => error.message).join('; ')}`);
  }
  if (testError) throw testError;
  assert.equal((await get()).body.ok, true, 'clean again after restoring');
});
