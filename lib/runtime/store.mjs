/**
 * Durable operation store — condensed port of runtime/durable_store.py.
 * JSON-per-operation + append-only events JSONL under $DSH_HOME/redteam-mode/operations/.
 * Idempotency via operation key; crash-safe writes via tmp+rename.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { operationsRoot } from '../state.mjs'

const opPath = (runId) => join(operationsRoot(), `${runId}.json`)
const eventsPath = (runId) => join(operationsRoot(), `${runId}.events.jsonl`)

export function newRunId(sessionKey) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `op-${sessionKey || 'default'}-${stamp}-${randomUUID().slice(0, 8)}`
}

export function saveOperation(op) {
  mkdirSync(operationsRoot(), { recursive: true })
  const target = opPath(op.run_id)
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(op, null, 2), 'utf8')
  try { renameSync(tmp, target) } catch { writeFileSync(target, JSON.stringify(op, null, 2), 'utf8') }
}

export function loadOperation(runId) {
  const target = opPath(String(runId ?? '').trim())
  if (!existsSync(target)) return null
  try {
    const raw = JSON.parse(readFileSync(target, 'utf8'))
    return raw && typeof raw === 'object' ? raw : null
  } catch {
    return null
  }
}

/** Find the most recent non-terminal operation for a session. */
export function findActiveOperation(sessionKey) {
  const ids = listOperationIds(sessionKey)
  for (const id of ids) {
    const op = loadOperation(id)
    if (op && op.status !== 'completed' && op.status !== 'cancelled' && op.status !== 'failed') return op
  }
  return null
}

function readdirSafe() {
  try {
    return readdirSync(operationsRoot())
  } catch {
    return []
  }
}

function listOperationIds(sessionKey, limit = 20) {
  return readdirSafe()
    .filter((name) => name.endsWith('.json'))
    .map((name) => name.slice(0, -5))
    .filter((id) => !sessionKey || id.includes(`op-${sessionKey}-`))
    .sort()
    .reverse()
    .slice(0, limit)
}

export function listOperations(sessionKey, limit = 20) {
  return listOperationIds(sessionKey, limit)
    .map(loadOperation)
    .filter(Boolean)
}

export function appendEvent(runId, type, data) {
  try {
    mkdirSync(dirname(eventsPath(runId)), { recursive: true })
    appendFileSync(
      eventsPath(runId),
      JSON.stringify({ ts: new Date().toISOString(), type, ...(data ? { data } : {}) }) + '\n',
      'utf8',
    )
  } catch {
    // Event log is best-effort; never fail an operation over it.
  }
}

export function readEvents(runId, tail = 50) {
  try {
    const lines = readFileSync(eventsPath(runId), 'utf8').trim().split('\n').filter(Boolean)
    return lines.slice(-tail).map((line) => {
      try { return JSON.parse(line) } catch { return { ts: '', type: 'corrupt', line } }
    })
  } catch {
    return []
  }
}
