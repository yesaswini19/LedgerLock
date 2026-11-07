'use strict';
const jwt = require('jsonwebtoken');
const { pool } = require('./db');
const { ApiError } = require('./errors');

function secret() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is not set');
  return process.env.JWT_SECRET;
}
const signToken = (u) => jwt.sign({ sub: String(u.id) }, secret(), { expiresIn: '8h' });

// Verifies the token, then re-reads the user (and role) from the DB on every request.
async function authenticate(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) throw new ApiError(401, 'UNAUTHENTICATED', 'Missing bearer token');
    let payload;
    try { payload = jwt.verify(h.slice(7), secret()); }
    catch { throw new ApiError(401, 'UNAUTHENTICATED', 'Invalid or expired token'); }
    const r = await pool.query('SELECT id, email, role FROM users WHERE id = $1', [Number(payload.sub)]);
    if (!r.rows[0]) throw new ApiError(401, 'UNAUTHENTICATED', 'Unknown user');
    req.user = r.rows[0];
    next();
  } catch (e) { next(e); }
}

const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user.role) ? next() : next(new ApiError(403, 'ROLE_NOT_ALLOWED', `Requires role: ${roles.join(' or ')}`));

module.exports = { signToken, authenticate, requireRole };
