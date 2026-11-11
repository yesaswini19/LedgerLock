'use strict';
const { pool } = require('./db');

async function recordAudit(action, actorId = null, targetId = null, details = {}) {
  try {
    await pool.query(
      'INSERT INTO audit_events (action, actor_id, target_id, details) VALUES ($1,$2,$3,$4)',
      [action, actorId, targetId == null ? null : String(targetId), JSON.stringify(details)]);
  } catch {
    // Audit failure must not leak request data or secrets into logs.
    console.error(JSON.stringify({ level: 'error', event: 'audit.write_failed', action }));
  }
}

module.exports = { recordAudit };
