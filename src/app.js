'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { ApiError } = require('./errors');
const { signToken, authenticate, requireRole } = require('./auth');
const { postMovement, verifyLedger, MAX_AMOUNT } = require('./ledger');
const { recordAudit } = require('./audit');

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy': "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  });
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '../public')));
const wrap = (fn) => (req, res, next) => fn(req, res, next).catch(next);

// ---------- validation helpers ----------
function parseId(v, name = 'id') {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new ApiError(400, 'VALIDATION', `${name} must be a positive integer`);
  return n;
}
function parseAmount(v) {
  if (!Number.isSafeInteger(v) || v <= 0 || v > MAX_AMOUNT) {
    throw new ApiError(400, 'VALIDATION', `amount must be a positive integer number of paise (max ${MAX_AMOUNT})`);
  }
  return v;
}
function parseKey(req) {
  const k = req.get('Idempotency-Key');
  if (!k || !/^[A-Za-z0-9_-]{8,64}$/.test(k)) {
    throw new ApiError(400, 'VALIDATION', 'Idempotency-Key header required (8-64 chars: letters, digits, _ or -)');
  }
  return k;
}

// ---------- auth ----------
app.get('/health', wrap(async (req, res) => { await pool.query('SELECT 1'); res.json({ ok: true }); }));

// Distinct client-side pages, all served by this Express application and origin.
app.get(['/signin', '/register', '/dashboard', '/admin', '/auditor'], (req, res) =>
  res.sendFile(path.join(__dirname, '../public/index.html')));

function validEmail(email) { return typeof email === 'string' && email.length <= 254 && /^\S+@\S+\.\S+$/.test(email); }
function validPassword(password, minimum) {
  return typeof password === 'string' && password.length >= minimum && Buffer.byteLength(password, 'utf8') <= 72;
}
function bootstrapSecretMatches(candidate) {
  const expected = process.env.BOOTSTRAP_SECRET;
  if (typeof expected !== 'string' || expected.length < 32 || typeof candidate !== 'string') return false;
  const a = Buffer.from(expected); const b = Buffer.from(candidate);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

app.post('/auth/bootstrap-admin', wrap(async (req, res) => {
  if (!bootstrapSecretMatches(req.get('X-Bootstrap-Secret'))) {
    await recordAudit('auth.bootstrap.refused');
    throw new ApiError(403, 'BOOTSTRAP_UNAVAILABLE', 'Administrator initialization is unavailable');
  }
  const { email, password } = req.body || {};
  if (!validEmail(email) || !validPassword(password, 12)) {
    throw new ApiError(400, 'VALIDATION', 'Valid email and a password of at least 12 characters (maximum 72 UTF-8 bytes) required');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [78120419]);
    const exists = await client.query("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
    if (exists.rowCount) {
      await client.query('ROLLBACK');
      await recordAudit('auth.bootstrap.refused');
      throw new ApiError(409, 'BOOTSTRAP_COMPLETE', 'Administrator initialization is already complete');
    }
    const created = (await client.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'admin') RETURNING id, email, role",
      [email.toLowerCase(), await bcrypt.hash(password, 10)])).rows[0];
    await client.query('COMMIT');
    await recordAudit('auth.bootstrap.completed', created.id, created.id);
    res.status(201).json({ user: created, token: signToken(created) });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') throw new ApiError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw error;
  } finally { client.release(); }
}));

app.post('/auth/register', wrap(async (req, res) => {   // self-registration always creates a 'holder'
  const { fullName, email, password } = req.body || {};
  if (typeof fullName !== 'string' || !fullName.trim() || fullName.trim().length > 80 ||
      !validEmail(email) || !validPassword(password, 8)) {
    throw new ApiError(400, 'VALIDATION', 'Full name (max 80 characters), valid email, and a password of at least 8 characters (maximum 72 UTF-8 bytes) required');
  }
  try {
    const r = await pool.query(
      "INSERT INTO users (full_name, email, password_hash, role) VALUES ($1,$2,$3,'holder') RETURNING id, email, role, full_name AS \"fullName\"",
      [fullName.trim(), email.toLowerCase(), await bcrypt.hash(password, 10)]);
    await recordAudit('auth.register.completed', r.rows[0].id, r.rows[0].id);
    res.status(201).json({ user: r.rows[0], message: 'Registration successful. Please sign in.' });
  } catch (e) {
    if (e.code === '23505') throw new ApiError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw e;
  }
}));

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
app.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') throw new ApiError(400, 'VALIDATION', 'email and password required');
  const u = (await pool.query('SELECT id, email, role, full_name AS \"fullName\", password_hash, is_active FROM users WHERE email = $1', [email.toLowerCase()])).rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok || !u.is_active) {
    await recordAudit('auth.login.failed', null, typeof email === 'string' ? email.toLowerCase() : null);
    throw new ApiError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
  }
  await recordAudit('auth.login.succeeded', u.id, u.id);
  res.json({ user: { id: u.id, email: u.email, fullName: u.fullName, role: u.role }, token: signToken(u) });
}));

app.get('/me', authenticate, (req, res) => res.json(req.user));

app.get('/admin/users', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const result = await pool.query('SELECT id, email, full_name AS "fullName", role, is_active, created_at FROM users ORDER BY id DESC LIMIT 500');
  res.json(result.rows.map((u) => ({ id: u.id, fullName: u.fullName, email: u.email, role: u.role, status: u.is_active ? 'active' : 'disabled', createdAt: u.created_at })));
}));

app.post('/admin/users', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const { email, password, role } = req.body || {};
  if (!validEmail(email) || !validPassword(password, 12) || !['admin', 'holder', 'auditor'].includes(role)) {
    throw new ApiError(400, 'VALIDATION', 'Valid email, a password of at least 12 characters (maximum 72 UTF-8 bytes), and a supported role required');
  }
  try {
    const user = (await pool.query('INSERT INTO users (email, password_hash, role) VALUES ($1,$2,$3) RETURNING id,email,role,is_active,created_at',
      [email.toLowerCase(), await bcrypt.hash(password, 10), role])).rows[0];
    await recordAudit('admin.user.created', req.user.id, user.id, { role });
    res.status(201).json({ id: user.id, email: user.email, role: user.role, status: 'active', createdAt: user.created_at });
  } catch (error) {
    if (error.code === '23505') throw new ApiError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw error;
  }
}));

app.patch('/admin/users/:id/status', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const id = parseId(req.params.id);
  if (typeof req.body?.active !== 'boolean') throw new ApiError(400, 'VALIDATION', 'active must be a boolean');
  if (id === req.user.id && !req.body.active) throw new ApiError(422, 'VALIDATION', 'Administrators cannot disable their own account');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [78120419]);
    const target = (await client.query('SELECT id, role FROM users WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!target) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    if (!req.body.active && target.role === 'admin') {
      const count = Number((await client.query("SELECT count(*)::int AS n FROM users WHERE role='admin' AND is_active=true")).rows[0].n);
      if (count <= 1) throw new ApiError(422, 'LAST_ADMIN', 'The last active administrator cannot be disabled');
    }
    const updated = (await client.query('UPDATE users SET is_active=$1 WHERE id=$2 RETURNING id,email,role,is_active,created_at', [req.body.active, id])).rows[0];
    await client.query('COMMIT');
    await recordAudit('admin.user.status_changed', req.user.id, id, { active: req.body.active });
    res.json({ id: updated.id, email: updated.email, role: updated.role, status: updated.is_active ? 'active' : 'disabled', createdAt: updated.created_at });
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
  finally { client.release(); }
}));

// ---------- accounts ----------
async function loadAccountFor(user, idParam) {
  const id = parseId(idParam);
  const a = (await pool.query('SELECT id, owner_id, name, kind, balance FROM accounts WHERE id = $1', [id])).rows[0];
  const allowed = a && (user.role !== 'holder' || a.owner_id === user.id);
  if (!allowed) throw new ApiError(a ? 403 : 404, a ? 'NOT_YOUR_ACCOUNT' : 'ACCOUNT_NOT_FOUND', a ? 'Not your account' : 'Account not found');
  return a;
}
const shape = (a) => ({ id: a.id, ownerId: a.owner_id, name: a.name, kind: a.kind, balance: a.balance });

app.post('/accounts', authenticate, requireRole('admin', 'holder'), wrap(async (req, res) => {
  const { name } = req.body || {};
  if (typeof name !== 'string' || !name.trim() || name.length > 60) throw new ApiError(400, 'VALIDATION', 'name required (max 60 chars)');
  let ownerId = req.user.id;
  if (req.user.role === 'admin') {
    ownerId = parseId(req.body.ownerId, 'ownerId');
    const o = (await pool.query("SELECT id FROM users WHERE id=$1 AND role='holder'", [ownerId])).rows[0];
    if (!o) throw new ApiError(422, 'VALIDATION', 'ownerId must be an account holder');
  }
  const r = await pool.query(
    "INSERT INTO accounts (owner_id, name) VALUES ($1,$2) RETURNING id, owner_id, name, kind, balance", [ownerId, name.trim()]);
  await recordAudit('account.created', req.user.id, r.rows[0].id, { ownerId });
  res.status(201).json(shape(r.rows[0]));
}));

app.get('/accounts', authenticate, wrap(async (req, res) => {
  const r = req.user.role === 'holder'
    ? await pool.query('SELECT id, owner_id, name, kind, balance FROM accounts WHERE owner_id = $1 ORDER BY id', [req.user.id])
    : await pool.query('SELECT id, owner_id, name, kind, balance FROM accounts ORDER BY id');
  res.json(r.rows.map(shape));
}));

app.get('/accounts/:id', authenticate, wrap(async (req, res) => res.json(shape(await loadAccountFor(req.user, req.params.id)))));

app.get('/accounts/:id/statement', authenticate, wrap(async (req, res) => {
  const acct = await loadAccountFor(req.user, req.params.id);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
  const [entries, attempts] = await Promise.all([
    pool.query(
      `SELECT e.id, e.txn_id, e.direction, e.amount, e.balance_after, e.created_at, e.initiated_by, u.email, t.type,
              t.from_account_id, t.to_account_id
         FROM ledger_entries e JOIN transactions t ON t.id = e.txn_id JOIN users u ON u.id = e.initiated_by
        WHERE e.account_id = $1 ORDER BY e.id DESC LIMIT $2`, [acct.id, limit]),
    pool.query(
      `SELECT a.id, a.user_id, u.email, a.action, a.from_account_id, a.to_account_id, a.amount, a.outcome, a.reason, a.created_at
         FROM attempts a LEFT JOIN users u ON u.id = a.user_id
        WHERE a.from_account_id = $1 OR a.to_account_id = $1 ORDER BY a.id DESC LIMIT $2`, [acct.id, limit])]);
  // Holders see who acted only as "you" / "another user"; admin and auditor see emails.
  const who = (userId, email) => req.user.role !== 'holder' ? { userId, email }
    : { by: userId === req.user.id ? 'you' : 'another user' };
  const items = [
    ...entries.rows.map((r) => ({ kind: 'posting', at: r.created_at, transactionId: r.txn_id, type: r.type,
      direction: r.direction, amount: r.amount, balanceAfter: r.balance_after,
      fromAccountId: r.from_account_id, toAccountId: r.to_account_id, initiatedBy: who(r.initiated_by, r.email) })),
    ...attempts.rows.map((r) => ({ kind: r.outcome, at: r.created_at, action: r.action, amount: r.amount,
      reason: r.reason, fromAccountId: r.from_account_id, toAccountId: r.to_account_id, initiatedBy: who(r.user_id, r.email) }))];
  items.sort((a, b) => new Date(b.at) - new Date(a.at));
  res.json({ account: shape(acct), items: items.slice(0, limit) });
}));

// ---------- money movement (role + ownership are enforced inside postMovement) ----------
const sendResult = (res, r) => res.status(r.status).set('Idempotent-Replay', String(r.replay)).json(r.body);

app.post('/accounts/:id/deposit', authenticate, wrap(async (req, res) => {
  const accountId = parseId(req.params.id);
  const amount = parseAmount((req.body || {}).amount);
  const key = parseKey(req);
  sendResult(res, await postMovement({ user: req.user, type: 'deposit', accountId, amount, key }));
}));

app.post('/accounts/:id/withdraw', authenticate, wrap(async (req, res) => {
  const accountId = parseId(req.params.id);
  const amount = parseAmount((req.body || {}).amount);
  const key = parseKey(req);
  sendResult(res, await postMovement({ user: req.user, type: 'withdrawal', accountId, amount, key }));
}));

app.post('/transfers', authenticate, wrap(async (req, res) => {
  const b = req.body || {};
  const accountId = parseId(b.fromAccountId, 'fromAccountId');
  const toAccountId = parseId(b.toAccountId, 'toAccountId');
  const amount = parseAmount(b.amount);
  const key = parseKey(req);
  if (accountId === toAccountId) throw new ApiError(400, 'VALIDATION', 'fromAccountId and toAccountId must differ');
  sendResult(res, await postMovement({ user: req.user, type: 'transfer', accountId, toAccountId, amount, key }));
}));

// ---------- audit (admin + auditor, read-only) ----------
app.get('/audit/verify', authenticate, requireRole('admin', 'auditor'), wrap(async (req, res) => res.json(await verifyLedger())));

app.get('/audit/attempts', authenticate, requireRole('admin', 'auditor'), wrap(async (req, res) => {
  const outcome = ['refused', 'replayed'].includes(req.query.outcome) ? req.query.outcome : null;
  const r = await pool.query(
    `SELECT a.id, a.user_id, u.email, a.action, a.from_account_id, a.to_account_id, a.amount, a.idempotency_key,
            a.outcome, a.reason, a.created_at
       FROM attempts a LEFT JOIN users u ON u.id = a.user_id
      WHERE ($1::text IS NULL OR a.outcome = $1) ORDER BY a.id DESC LIMIT 200`, [outcome]);
  res.json(r.rows);
}));

app.get('/admin/audit-events', authenticate, requireRole('admin'), wrap(async (req, res) => {
  const rows = await pool.query(
    `SELECT a.id, a.action, a.actor_id, actor.email AS actor_email, a.target_id, a.details, a.created_at
       FROM audit_events a LEFT JOIN users actor ON actor.id=a.actor_id
      ORDER BY a.id DESC LIMIT 200`);
  res.json(rows.rows.map((row) => ({ id: row.id, action: row.action, actor: row.actor_id ? { id: row.actor_id, email: row.actor_email } : null,
    targetId: row.target_id, details: row.details, at: row.created_at })));
}));

// ---------- errors ----------
app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid JSON' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Body too large' } });
  console.error(JSON.stringify({ level: 'error', event: 'http.request_failed', error: err.name || 'Error', code: err.code || 'INTERNAL' }));
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
});

module.exports = app;
