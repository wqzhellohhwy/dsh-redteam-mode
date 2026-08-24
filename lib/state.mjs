/**
 * Red-team session state — port of codex hooks/redteam_state.py + state_manager.py.
 * Durable per-session JSON under $DSH_HOME/redteam-mode/state/.
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
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

export function operationsRoot() {
  const override = process.env.DSH_REDTEAM_OPS_DIR
  return override ? override : join(dshHome(), 'redteam-mode', 'operations')
}

export function safeSessionKey(sessionId) {
  const raw = String(sessionId ?? '').trim()
  if (!raw) throw new Error('session_id is required for persistent red-team state')
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120)
}

export const statePath = (sessionId) => join(stateRoot(), `${safeSessionKey(sessionId)}.json`)

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

export function loadState(sessionId) {
  if (!sessionId || !String(sessionId).trim()) return defaultState()
  const path = statePath(sessionId)
  if (!existsSync(path)) {
    const fresh = defaultState(String(sessionId))
    return fresh
  }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
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
  mkdirSync(dirname(target), { recursive: true })
  const tmp = target + '.tmp'
  writeFileSync(tmp, JSON.stringify(working, null, 2), 'utf8')
  try { renameSync(tmp, target) } catch { /* Windows replace race — keep tmp fallback */ writeFileSync(target, JSON.stringify(working, null, 2), 'utf8') }
  return working
}
