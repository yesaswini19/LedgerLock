'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const request = require('supertest');
process.env.JWT_SECRET = 'bootstrap-unit-test-secret-value-long-enough';
process.env.BOOTSTRAP_SECRET = 'bootstrap-unit-test-secret-value-long-enough';
const app = require('../src/app');
const { pool } = require('../src/db');
const originalConnect = pool.connect.bind(pool);
const originalQuery = pool.query.bind(pool);
let admins = [];
let unlock = () => {};
let lockTail = Promise.resolve();

function resetState() { admins = []; lockTail = Promise.resolve(); }
pool.connect = async () => {
  let locked = false;
  return {
    async query(sql, values = []) {
      if (sql === 'BEGIN') return { rows: [], rowCount: 0 };
      if (sql === 'COMMIT' || sql === 'ROLLBACK') { if (locked) { locked = false; unlock(); } return { rows: [], rowCount: 0 }; }
      if (sql.startsWith('SELECT pg_advisory_xact_lock')) {
        let release;
        const prior = lockTail;
        lockTail = new Promise((resolve) => { release = resolve; });
        await prior; locked = true; unlock = release;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("SELECT 1 FROM users WHERE role='admin'")) return { rows: admins.length ? [{ one: 1 }] : [], rowCount: admins.length ? 1 : 0 };
      if (sql.includes("INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'admin')")) {
        const row = { id: admins.length + 1, email: values[0], role: 'admin', password_hash: values[1] };
        admins.push(row); return { rows: [{ id: row.id, email: row.email, role: row.role }], rowCount: 1 };
      }
      throw new Error(`Unexpected bootstrap test SQL: ${sql}`);
    },
    release() {},
  };
};
pool.query = async (sql) => {
  if (sql.includes('INSERT INTO audit_events')) return { rows: [], rowCount: 1 };
  return originalQuery(sql);
};
after(() => { pool.connect = originalConnect; pool.query = originalQuery; });

const secret = 'bootstrap-unit-test-secret-value-long-enough';
const body = { email: 'first-admin@example.test', password: 'Long-Enough-Demo-Password-123' };

test('BOOTSTRAP: only a valid one-time secret initializes the first admin', async () => {
  resetState();
  const denied = await request(app).post('/auth/bootstrap-admin').set('X-Bootstrap-Secret', 'wrong-secret').send(body);
  assert.equal(denied.status, 403);
  assert.equal(JSON.stringify(denied.body).includes(secret), false);
  const invalid = await request(app).post('/auth/bootstrap-admin').set('X-Bootstrap-Secret', secret).send({ email: 'bad', password: 'short' });
  assert.equal(invalid.status, 400);
  const created = await request(app).post('/auth/bootstrap-admin').set('X-Bootstrap-Secret', secret).send(body);
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.user, { id: 1, email: body.email, role: 'admin' });
  const claims = jwt.verify(created.body.token, process.env.JWT_SECRET);
  assert.equal(claims.sub, '1');
  assert.equal(claims.exp - claims.iat, 8 * 60 * 60);
  assert.equal(await bcrypt.compare(body.password, admins[0].password_hash), true);
  const repeated = await request(app).post('/auth/bootstrap-admin').set('X-Bootstrap-Secret', secret).send(body);
  assert.equal(repeated.status, 409);
  assert.equal(admins.length, 1);
});

test('BOOTSTRAP: concurrent first-admin requests create exactly one administrator', async () => {
  resetState();
  const responses = await Promise.all(Array.from({ length: 2 }, () =>
    request(app).post('/auth/bootstrap-admin').set('X-Bootstrap-Secret', secret).send(body)));
  assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
  assert.equal(admins.length, 1);
});
