'use strict';
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('./db');
const { ApiError } = require('./errors');
const { signToken, authenticate, requireRole } = require('./auth');
const { postMovement, verifyLedger, MAX_AMOUNT } = require('./ledger');

const app = express();
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

app.post('/auth/register', wrap(async (req, res) => {   // self-registration always creates a 'holder'
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email) || typeof password !== 'string' || password.length < 8) {
    throw new ApiError(400, 'VALIDATION', 'Valid email and a password of at least 8 characters required');
  }
  try {
    const r = await pool.query(
      "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'holder') RETURNING id, email, role",
      [email.toLowerCase(), await bcrypt.hash(password, 10)]);
    res.status(201).json({ user: r.rows[0], token: signToken(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') throw new ApiError(409, 'EMAIL_TAKEN', 'Email already registered');
    throw e;
  }
}));

const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);
app.post('/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  if (typeof email !== 'string' || typeof password !== 'string') throw new ApiError(400, 'VALIDATION', 'email and password required');
  const u = (await pool.query('SELECT id, email, role, password_hash FROM users WHERE email = $1', [email.toLowerCase()])).rows[0];
  const ok = await bcrypt.compare(password, u ? u.password_hash : DUMMY_HASH);
  if (!u || !ok) throw new ApiError(401, 'BAD_CREDENTIALS', 'Invalid email or password');
  res.json({ user: { id: u.id, email: u.email, role: u.role }, token: signToken(u) });
}));

app.get('/me', authenticate, (req, res) => res.json(req.user));

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

// ---------- errors ----------
app.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Route not found')));
app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'VALIDATION', message: 'Invalid JSON' } });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: { code: 'TOO_LARGE', message: 'Body too large' } });
  console.error(err); // never leak internals to the client
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Internal error' } });
});

module.exports = app;
