'use strict';
// The heart of LedgerLine. Every deposit, withdrawal and transfer goes through postMovement().
const crypto = require('crypto');
const { pool, withTx } = require('./db');
const { ApiError } = require('./errors');

const MAX_AMOUNT = 1e12; // paise per operation (keeps all sums inside JS safe-integer range)
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Which role may start which kind of movement (decided server-side on every request).
const ROLE_FOR = { deposit: 'admin', withdrawal: 'holder', transfer: 'holder' };

function entryHash(prevHash, e) {
  return sha256([prevHash || 'GENESIS', e.accountId, e.txnId, e.direction, e.amount,
    e.balanceAfter, e.initiatedBy, e.createdAt].join('|'));
}

let externalId = null;
async function getExternalId() {
  if (externalId === null) {
    const r = await pool.query("SELECT id FROM accounts WHERE kind = 'external'");
    externalId = r.rows[0].id;
  }
  return externalId;
}

// Refused attempts / replays are written on the pool (NOT inside the money transaction),
// because that transaction has rolled back and would take the log row with it.
async function logAttempt(a) {
  try {
    await pool.query(
      `INSERT INTO attempts (user_id, action, from_account_id, to_account_id, amount, idempotency_key, outcome, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [a.userId, a.action, a.fromId, a.toId, a.amount, a.key, a.outcome, a.reason]);
  } catch (e) { console.error('failed to log attempt', e.message); }
}

async function postMovement({ user, type, accountId, toAccountId, amount, key }) {
  const ext = await getExternalId();
  let fromId, toId;
  if (type === 'deposit') { fromId = ext; toId = accountId; }
  else if (type === 'withdrawal') { fromId = accountId; toId = ext; }
  else { fromId = accountId; toId = toAccountId; }
  const requestHash = sha256(JSON.stringify([type, fromId, toId, amount]));
  const log = (outcome, reason) =>
    logAttempt({ userId: user.id, action: type, fromId, toId, amount, key, outcome, reason });

  try {
    if (user.role !== ROLE_FOR[type]) throw new ApiError(403, 'ROLE_NOT_ALLOWED', `Role '${user.role}' cannot perform ${type}`);
    const result = await withTx((c) => run(c, { user, type, fromId, toId, amount, key, requestHash }));
    if (result.replay) await log('replayed', 'DUPLICATE_KEY');
    return result;
  } catch (e) {
    if (e instanceof ApiError) await log('refused', e.code);
    throw e;
  }
}

async function run(c, { user, type, fromId, toId, amount, key, requestHash }) {
  // 1. IDEMPOTENCY: claim the key first, inside this same transaction.
  //    If a concurrent request holds the same key, this INSERT waits until it commits or rolls back.
  const ins = await c.query(
    `INSERT INTO idempotency_keys (user_id, key, request_hash) VALUES ($1,$2,$3)
     ON CONFLICT (user_id, key) DO NOTHING RETURNING key`, [user.id, key, requestHash]);
  if (ins.rowCount === 0) {
    const prev = (await c.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id=$1 AND key=$2',
      [user.id, key])).rows[0];
    if (prev.request_hash !== requestHash) {
      throw new ApiError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request');
    }
    return { replay: true, status: prev.response_status, body: prev.response_body };
  }

  // 2. LOCK both accounts in ascending id order (same order for everyone => no deadlocks).
  //    Every later read of a balance happens AFTER this lock, so it cannot go stale.
  const ids = [...new Set([fromId, toId])].sort((a, b) => a - b);
  const { rows } = await c.query(
    'SELECT id, owner_id, kind, balance FROM accounts WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids]);
  if (rows.length !== ids.length) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Account not found');
  const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
  const from = byId[fromId];
  const to = byId[toId];

  // 3. AUTHORISE against the locked rows.
  if (type !== 'deposit' && from.owner_id !== user.id) {
    throw new ApiError(403, 'NOT_YOUR_ACCOUNT', 'You do not own the source account');
  }
  if (to.kind !== 'customer' && type !== 'withdrawal') {
    throw new ApiError(422, 'INVALID_DESTINATION', 'Destination must be a customer account');
  }
  if (fromId === toId) throw new ApiError(422, 'SAME_ACCOUNT', 'Source and destination are the same');

  // 4. CHECK FUNDS on the locked balance. No overdraft is offered (limit = 0).
  if (from.kind === 'customer' && from.balance < amount) {
    throw new ApiError(422, 'INSUFFICIENT_FUNDS', 'Insufficient funds');
  }

  // 5. POST: transaction row, then a debit and a credit, each with a new balance and hash-chain link.
  const createdAt = new Date().toISOString();
  const txnId = (await c.query(
    `INSERT INTO transactions (type, from_account_id, to_account_id, amount, initiated_by, idempotency_key, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [type, fromId, toId, amount, user.id, key, createdAt])).rows[0].id;

  const balances = {};
  for (const [accountId, direction] of [[fromId, 'debit'], [toId, 'credit']]) {
    const delta = direction === 'credit' ? amount : -amount;
    const balanceAfter = (await c.query(
      'UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING balance', [delta, accountId])).rows[0].balance;
    const prevHash = (await c.query(
      'SELECT hash FROM ledger_entries WHERE account_id = $1 ORDER BY id DESC LIMIT 1', [accountId])).rows[0]?.hash ?? null;
    const e = { accountId, txnId, direction, amount, balanceAfter, initiatedBy: user.id, createdAt };
    await c.query(
      `INSERT INTO ledger_entries (txn_id, account_id, direction, amount, balance_after, initiated_by, created_at, prev_hash, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [txnId, accountId, direction, amount, balanceAfter, user.id, createdAt, prevHash, entryHash(prevHash, e)]);
    balances[accountId] = balanceAfter;
  }

  // 6. Store the response under the key, still inside the same transaction. COMMIT makes it all real at once.
  const callerAccount = type === 'deposit' ? toId : fromId;
  const body = { transactionId: txnId, type, fromAccountId: fromId, toAccountId: toId, amount, balanceAfter: balances[callerAccount] };
  await c.query('UPDATE idempotency_keys SET response_status=201, response_body=$3 WHERE user_id=$1 AND key=$2',
    [user.id, key, JSON.stringify(body)]);
  return { replay: false, status: 201, body };
}

// Recomputes everything from the ledger and reports any mismatch. Read-only, one consistent snapshot.
async function verifyLedger() {
  return withTx(async (c) => {
    const problems = [];
    const total = Number((await c.query('SELECT COALESCE(SUM(balance),0) s FROM accounts')).rows[0].s);
    if (total !== 0) problems.push(`SUM(all balances) = ${total}, expected 0`);
    const net = Number((await c.query(
      "SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount ELSE -amount END),0) s FROM ledger_entries")).rows[0].s);
    if (net !== 0) problems.push(`SUM(debits) - SUM(credits) = ${net}, expected 0`);

    const entries = (await c.query(
      'SELECT * FROM ledger_entries ORDER BY account_id, id')).rows;
    const balances = Object.fromEntries((await c.query('SELECT id, balance FROM accounts')).rows.map((r) => [r.id, r.balance]));
    let prev = null, running = 0, cur = null;
    const lastByAccount = {};
    for (const r of entries) {
      if (r.account_id !== cur) { cur = r.account_id; prev = null; running = 0; }
      running += r.direction === 'credit' ? r.amount : -r.amount;
      if (r.prev_hash !== prev) problems.push(`entry ${r.id}: broken chain link`);
      const expect = entryHash(prev, { accountId: r.account_id, txnId: r.txn_id, direction: r.direction,
        amount: r.amount, balanceAfter: r.balance_after, initiatedBy: r.initiated_by, createdAt: r.created_at.toISOString() });
      if (expect !== r.hash) problems.push(`entry ${r.id}: hash mismatch (row was altered)`);
      if (running !== r.balance_after) problems.push(`entry ${r.id}: running balance mismatch`);
      prev = r.hash; lastByAccount[cur] = running;
    }
    for (const [id, bal] of Object.entries(balances)) {
      if ((lastByAccount[id] || 0) !== bal) problems.push(`account ${id}: stored balance ${bal} != ledger ${lastByAccount[id] || 0}`);
    }
    return { ok: problems.length === 0, entriesChecked: entries.length, accountsChecked: Object.keys(balances).length,
      sumOfAllBalances: total, problems: problems.slice(0, 50) };
  }, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
}

module.exports = { postMovement, verifyLedger, MAX_AMOUNT };
