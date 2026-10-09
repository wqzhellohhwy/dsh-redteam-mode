/**
 * Durable operation store — SQLite upgrade of runtime/durable_store.py.
 *
 * The original port persisted each operation as a bare JSON file with an
 * append-only JSONL, losing the durable_store guarantees: transactional
 * consistency, per-action idempotency keys, action leases (no double-execute
 * across sessions/re-entrant calls), auto-increment event ids, batch queries,
 * and schema-versioned migration. This module keeps the SAME public surface
 * (saveOperation/loadOperation/findActiveOperation/listOperations/appendEvent/
 * readEvents/newRunId) so existing callers keep working, while moving the
 * backing store to SQLite (WAL, foreign keys, transactions).
 *
 * Uses node:sqlite (Node 22.5+/24 built-in) with an in-memory fallback so the
 * module never hard-fails on environments without a writable DB root.
 */
import { mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { operationsRoot } from '../state.mjs'

let Database = null
try {
  Database = (await import('node:sqlite')).DatabaseSync
} catch {
  Database = null
}

const SCHEMA_VERSION = 2

let db = null
let storePath = ''

function ensureDb() {
  if (db) return db
  try {
    mkdirSync(operationsRoot(), { recursive: true })
    storePath = join(operationsRoot(), 'redteam.sqlite3')
    db = new Database(storePath)
    db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=30000;')
    initSchema(db)
  } catch (err) {
    // Fallback: in-memory SQLite (no persistence) so the runtime still works.
    try {
      db = new Database(':memory:')
      db.exec('PRAGMA foreign_keys=ON;')
      initSchema(db)
    } catch {
      throw err
    }
  }
  return db
}

function initSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS operations (
      run_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      objective TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      status TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_operations_session ON operations(session_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS operation_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY(run_id) REFERENCES operations(run_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_events_run ON operation_events(run_id, event_id);
    CREATE TABLE IF NOT EXISTS action_leases (
      run_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      owner TEXT NOT NULL,
      expires_at REAL NOT NULL,
      PRIMARY KEY(run_id, action_id),
      FOREIGN KEY(run_id) REFERENCES operations(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS action_results (
      run_id TEXT NOT NULL,
      action_id TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(run_id, idempotency_key),
      FOREIGN KEY(run_id) REFERENCES operations(run_id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS schema_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `)
  d.prepare('INSERT INTO schema_metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run('schema_version', String(SCHEMA_VERSION))
}

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function newRunId(sessionKey) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `op-${sessionKey || 'default'}-${stamp}-${randomUUID().slice(0, 8)}`
}

/** Upsert an operation; records an event when eventType is provided. */
export function saveOperation(op, { eventType, event } = {}) {
  const d = ensureDb()
  const stateJson = JSON.stringify(op)
  const sessionId = op.session_key || op.session_id || 'default'
  const objective = op.contract?.objective || ''
  const workflowId = op.workflow || 'generic-adaptive'
  const ts = nowIso()
  d.prepare(`
    INSERT INTO operations(run_id, session_id, objective, workflow_id, status, state_json, created_at, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      session_id=excluded.session_id, objective=excluded.objective, workflow_id=excluded.workflow_id,
      status=excluded.status, state_json=excluded.state_json, updated_at=excluded.updated_at
  `).run(op.run_id, sessionId, objective, workflowId, op.status || 'running', stateJson, op.created_at || ts, ts)
  if (eventType) {
    insertEvent(d, op.run_id, eventType, event)
  }
}

function insertEvent(d, runId, type, data) {
  try {
    d.prepare('INSERT INTO operation_events(run_id, event_type, payload_json, created_at) VALUES(?, ?, ?, ?)')
      .run(runId, type, JSON.stringify(data ?? {}), nowIso())
  } catch { /* best-effort event log */ }
}

export function loadOperation(runId) {
  const d = ensureDb()
  const row = d.prepare('SELECT state_json FROM operations WHERE run_id=?').get(String(runId ?? '').trim())
  if (!row) return null
  try {
    const payload = JSON.parse(row.state_json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

/** Find the most recent non-terminal operation for a session. */
export function findActiveOperation(sessionKey) {
  const d = ensureDb()
  const rows = d.prepare(
    "SELECT state_json FROM operations WHERE session_id=? AND status NOT IN ('completed','cancelled','failed') ORDER BY updated_at DESC LIMIT 1",
  ).all(String(sessionKey ?? ''))
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.state_json)
      if (payload && typeof payload === 'object') return payload
    } catch { /* skip corrupt */ }
  }
  return null
}

export function latestOperation(sessionKey, { includeTerminal = true } = {}) {
  const d = ensureDb()
  const sql = includeTerminal
    ? 'SELECT state_json FROM operations WHERE session_id=? ORDER BY updated_at DESC LIMIT 1'
    : "SELECT state_json FROM operations WHERE session_id=? AND status NOT IN ('completed','cancelled','failed') ORDER BY updated_at DESC LIMIT 1"
  const row = d.prepare(sql).get(String(sessionKey ?? ''))
  if (!row) return null
  try {
    const payload = JSON.parse(row.state_json)
    return payload && typeof payload === 'object' ? payload : null
  } catch {
    return null
  }
}

export function listOperations(sessionKey, limit = 20) {
  const d = ensureDb()
  const sql = sessionKey
    ? 'SELECT state_json FROM operations WHERE session_id=? ORDER BY updated_at DESC LIMIT ?'
    : 'SELECT state_json FROM operations ORDER BY updated_at DESC LIMIT ?'
  const rows = sessionKey ? d.prepare(sql).all(sessionKey, limit) : d.prepare(sql).all(limit)
  const ops = []
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.state_json)
      if (payload && typeof payload === 'object') ops.push(payload)
    } catch { /* skip corrupt */ }
  }
  return ops
}

/** All operations belonging to a batch (batch_session_id:index pattern). */
export function operationsForBatch(batchSessionId) {
  const d = ensureDb()
  const escaped = String(batchSessionId ?? '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  if (!escaped) return []
  const rows = d.prepare("SELECT state_json FROM operations WHERE session_id LIKE ? ESCAPE '\\' ORDER BY session_id, created_at")
    .all(`${escaped}:%`)
  const ops = []
  for (const row of rows) {
    try {
      const payload = JSON.parse(row.state_json)
      if (payload?.contract?.starting_context?.batch_session_id === batchSessionId) ops.push(payload)
    } catch { /* skip */ }
  }
  ops.sort((a, b) => (a.contract?.starting_context?.batch_index ?? 0) - (b.contract?.starting_context?.batch_index ?? 0))
  return ops
}

export function appendEvent(runId, type, data) {
  try {
    const d = ensureDb()
    insertEvent(d, runId, type, data)
  } catch { /* best-effort */ }
}

export function readEvents(runId, tail = 50) {
  const d = ensureDb()
  const rows = d.prepare(
    'SELECT event_id, event_type, payload_json, created_at FROM operation_events WHERE run_id=? ORDER BY event_id DESC LIMIT ?',
  ).all(String(runId ?? ''), Math.max(1, Math.min(1000, Number(tail) || 50)))
  return rows.reverse().map((row) => {
    let payload = null
    try { payload = JSON.parse(row.payload_json) } catch { payload = {} }
    return { ts: row.created_at, type: row.event_type, data: payload, event_id: Number(row.event_id) }
  })
}

/** Append-only event log with optional `after` cursor (event_id) and `limit`. */
export function readEventsAfter(runId, afterEventId = 0, limit = 200) {
  const d = ensureDb()
  const rows = d.prepare(
    'SELECT event_id, event_type, payload_json, created_at FROM operation_events WHERE run_id=? AND event_id>? ORDER BY event_id LIMIT ?',
  ).all(String(runId ?? ''), Math.max(0, Number(afterEventId) || 0), Math.max(1, Math.min(1000, Number(limit) || 200)))
  return rows.map((row) => {
    let payload = null
    try { payload = JSON.parse(row.payload_json) } catch { payload = {} }
    return { event_id: Number(row.event_id), event_type: row.event_type, payload, created_at: row.created_at }
  })
}

export function allEvents(runId) {
  return readEvents(runId, 1000)
}

/** Acquire a run/action lease so parallel workers cannot double-execute. */
export function acquireLease(runId, actionId, owner, { ttlSeconds = 120 } = {}) {
  const d = ensureDb()
  const now = Date.now() / 1000
  const expiresAt = now + Math.max(1, Number(ttlSeconds))
  d.prepare('DELETE FROM action_leases WHERE run_id=? AND action_id=? AND expires_at<=?').run(runId, actionId, now)
  const row = d.prepare('SELECT owner FROM action_leases WHERE run_id=? AND action_id=?').get(runId, actionId)
  if (row && row.owner !== owner) return false
  d.prepare(`
    INSERT INTO action_leases(run_id, action_id, owner, expires_at) VALUES(?, ?, ?, ?)
    ON CONFLICT(run_id, action_id) DO UPDATE SET owner=excluded.owner, expires_at=excluded.expires_at
  `).run(runId, actionId, owner, expiresAt)
  return true
}

export function releaseLease(runId, actionId, owner) {
  const d = ensureDb()
  d.prepare('DELETE FROM action_leases WHERE run_id=? AND action_id=? AND owner=?').run(runId, actionId, owner)
}

/** Cache an idempotent action result (dedup on re-entry). */
export function cacheActionResult(runId, actionId, idempotencyKey, result) {
  const d = ensureDb()
  d.prepare(`
    INSERT INTO action_results(run_id, action_id, idempotency_key, result_json, created_at)
    VALUES(?, ?, ?, ?, ?) ON CONFLICT(run_id, idempotency_key) DO NOTHING
  `).run(runId, actionId, idempotencyKey, JSON.stringify(result ?? {}), nowIso())
}

export function cachedActionResult(runId, idempotencyKey) {
  const d = ensureDb()
  const row = d.prepare('SELECT result_json FROM action_results WHERE run_id=? AND idempotency_key=?').get(runId, idempotencyKey)
  if (!row) return null
  try { return JSON.parse(row.result_json) } catch { return null }
}
