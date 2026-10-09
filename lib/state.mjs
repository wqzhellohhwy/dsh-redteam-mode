/**
 * Red-team session state — port of codex hooks/redteam_state.py + state_manager.py.
 * Durable per-session JSON under $DSH_HOME/redteam-mode/state/sessions/.
 *
 * Upgrades the port's flat state/ layout to the original's:
 *   - state_dir  = state_root/sessions/    (per-session state files)
 *   - memory_dir = state_root/memory/      (long-lived memory, reserved)
 *   - session_state_lock (file lock)       (prevents concurrent writes)
 *   - 0700 dir / 0600 file permissions     (POSIX hardening)
 * A backwards-compatible read migrates legacy flat state/ files into sessions/
 * so existing sessions are not lost when the path changes.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, chmodSync, openSync, closeSync, writeSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

export const VALID_MODES = new Set(['normal', 'redteam-light', 'redteam-full'])
export const VALID_OPSEC = new Set(['strict', 'balanced'])
export const VALID_INTENTS = new Set(['new', 'continue', 'revise', 'verify', 'summarize'])

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

export function stateRoot() {
  const override = process.env.DSH_REDTEAM_STATE_DIR
  return override ? override : join(dshHome(), 'redteam-mode', 'state')
}

export function stateDir() {
  return join(stateRoot(), 'sessions')
}

export function memoryDir() {
  return join(stateRoot(), 'memory')
}

export function operationsRoot() {
  const override = process.env.DSH_REDTEAM_OPS_DIR
  return override ? override : join(dshHome(), 'redteam-mode', 'operations')
}

export function safeSessionKey(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (!raw) throw new Error('session_id is required for persistent red-team state')
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120)
}

/** New layout path. */
export const statePath = (sessionId) => join(stateDir(), `${safeSessionKey(sessionId)}.json`)

/** Legacy flat layout path (pre-sessions/), used for back-compat migration. */
function legacyStatePath(sessionId) {
  return join(stateRoot(), `${safeSessionKey(sessionId)}.json`)
}

function secureDir(path) {
  try {
    mkdirSync(path, { recursive: true })
    if (process.platform !== 'win32') chmodSync(path, 0o700)
  } catch { /* best-effort */ }
}

function secureFile(path) {
  try {
    if (process.platform !== 'win32' && existsSync(path)) chmodSync(path, 0o600)
  } catch { /* best-effort */ }
}

/**
 * Acquire an exclusive per-session file lock (creates <path>.lock).
 * Returns a release function. Stale locks (>30s) are reclaimed.
 *
 * Non-blocking by design: if another writer holds the lock, this returns a
 * no-op release right away rather than busy-spinning the event loop. The lock
 * is a defensive guard against concurrent writers, not a serialization gate.
 */
export function sessionStateLock(sessionId, { timeoutMs = 10000 } = {}) {
  let key
  try { key = safeSessionKey(sessionId) } catch { return () => {} }
  secureDir(stateDir())
  const lockPath = join(stateDir(), `${key}.lock`)
  const deadline = Date.now() + Math.max(100, timeoutMs)
  const tryLock = () => {
    try {
      const fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, `${process.pid}\n`)
      closeSync(fd)
      secureFile(lockPath)
      return true
    } catch {
      return false
    }
  }
  if (tryLock()) {
    return function release() { try { unlinkSync(lockPath) } catch { /* already gone */ } }
  }
  // Held by someone else. Reclaim stale locks, then retry a bounded number of times.
  try {
    if (Date.now() - statSync(lockPath).mtimeMs > 30000) {
      try { unlinkSync(lockPath) } catch { /* raced */ }
      if (tryLock()) return function release() { try { unlinkSync(lockPath) } catch { /* already gone */ } }
    }
  } catch { /* lock vanished */ }
  // Could not acquire within the deadline — callers proceed without a lock.
  return () => {}
}

export function defaultState(sessionId = '') {
  return {
    mode: 'normal',
    opsec_level: 'balanced',
    objective: '',
    intent_type: 'continue',
    last_changed: nowIso(),
    session_id: sessionId || '',
    pending_action: {},
    verified_artifacts: [],
    workflow_terminal: false,
    active_model: '',
    active_prompt_profile: '',
    operation_run_id: '',
    operation_run_ids: [],
    batch_session_id: '',
    workflow_id: '',
    operation_status: '',
    next_action_id: '',
    goal_terminal: false,
    goal_success: false,
    last_scene: '',
    last_action_kind: '',
    last_risk_level: '',
    last_context_bundle: [],
    last_taxonomy: [],
    activation_seq: 0,
  }
}

function normalize(state) {
  const base = defaultState(state.session_id)
  const out = { ...base }
  for (const key of Object.keys(base)) {
    const value = state[key]
    if (value === undefined) continue
    switch (typeof base[key]) {
      case 'boolean': out[key] = Boolean(value); break
      case 'string': out[key] = String(value ?? ''); break
      default: out[key] = value
    }
  }
  out.mode = VALID_MODES.has(out.mode) ? out.mode : 'normal'
  out.opsec_level = VALID_OPSEC.has(out.opsec_level) ? out.opsec_level : 'balanced'
  out.intent_type = VALID_INTENTS.has(out.intent_type) ? out.intent_type : 'continue'
  out.pending_action = out.pending_action && typeof out.pending_action === 'object' && !Array.isArray(out.pending_action)
    ? out.pending_action
    : {}
  out.verified_artifacts = Array.isArray(out.verified_artifacts) ? out.verified_artifacts : []
  out.operation_run_ids = Array.isArray(out.operation_run_ids) ? out.operation_run_ids : []
  out.last_context_bundle = Array.isArray(out.last_context_bundle) ? out.last_context_bundle : []
  out.last_taxonomy = Array.isArray(out.last_taxonomy) ? out.last_taxonomy : []
  return out
}

/** Read a state file from the new layout; fall back to and migrate legacy flat. */
function readStateFile(sessionId) {
  const key = safeSessionKey(sessionId)
  const newPath = statePath(sessionId)
  const legacyPath = legacyStatePath(sessionId)
  if (existsSync(newPath)) return { path: newPath, raw: readFileSync(newPath, 'utf8') }
  if (existsSync(legacyPath)) {
    // Legacy flat file — migrate it to the sessions/ layout.
    const raw = readFileSync(legacyPath, 'utf8')
    try {
      secureDir(stateDir())
      writeFileSync(newPath, raw, 'utf8')
      secureFile(newPath)
    } catch { /* migration best-effort */ }
    return { path: newPath, raw }
  }
  return null
}

export function loadState(sessionId) {
  if (!sessionId || !String(sessionId).trim()) return defaultState()
  const found = readStateFile(sessionId)
  if (!found) {
    return defaultState(String(sessionId))
  }
  try {
    const raw = JSON.parse(found.raw)
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return defaultState(String(sessionId))
    const state = normalize(raw)
    if (!state.session_id) state.session_id = String(sessionId)
    return state
  } catch {
    return defaultState(String(sessionId))
  }
}

export function saveState(state) {
  const working = normalize(state)
  const effectiveId = (working.session_id || '').trim()
  if (!effectiveId) return working
  working.session_id = effectiveId
  working.last_changed = nowIso()
  const target = statePath(effectiveId)
  secureDir(stateDir())
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(working, null, 2), 'utf8')
  secureFile(tmp)
  try { renameSync(tmp, target) } catch { /* Windows replace race */ writeFileSync(target, JSON.stringify(working, null, 2), 'utf8') }
  secureFile(target)
  return working
}

/** Reset a session to defaults (no saved file). */
export function resetState(sessionId) {
  const state = defaultState(sessionId)
  if (sessionId && String(sessionId).trim()) saveState(state)
  return state
}
