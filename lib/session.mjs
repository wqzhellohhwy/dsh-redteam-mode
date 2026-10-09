/**
 * Per-session red-team state cache + durable persistence bridge.
 *
 * The DSH 2.0 entry point may be mounted twice in one process:
 *   - once at the profile (host) layer, role='host'
 *   - once inside the redteam agent preset, role='preset'
 * Both instances share this module-level cache, so a mode set through
 * `/redteam` is immediately visible to every hook of the same session.
 */
import { loadState, saveState, safeSessionKey, defaultState } from './state.mjs'
import { hookTrace } from './trace.mjs'

export const PENDING_KEY = '__pending__'

/** sessionKey → { state, key }; live objects so hooks and tools mutate in place. */
export const sessions = new Map()

/**
 * Resolve the state key for one agent.
 *
 * The session id is normally available; on the very first message of a brand
 * new session it may not be, so a pending bucket captures mode commands and is
 * migrated to the real key by the `agent/created` / `agent/pre-step` handlers.
 */
export function sessionKeyOf(agent) {
  const sid = String(agent?.session?.id ?? agent?.id ?? '').trim()
  return sid ? safeSessionKey(sid) : PENDING_KEY
}

/** Look up (or lazily load) the live state entry for one agent. */
export function entryFor(agent) {
  const key = sessionKeyOf(agent)
  let entry = sessions.get(key)
  if (!entry) {
    const state = key === PENDING_KEY ? defaultState() : loadState(key)
    state.session_id = key
    entry = { state, key }
    sessions.set(key, entry)
    hookTrace({ ev: 'state-loaded', key, mode: state.mode })
  }
  return entry
}

/** Live state object for one agent (mutations are persisted by `persist`). */
export function stateFor(agent) {
  return entryFor(agent).state
}

/** Persist one state object; failures degrade to a trace line, never to a throw. */
export function persist(ctx, state) {
  try {
    saveState(state)
  } catch (error) {
    hookTrace({ ev: 'persist-failed', error: String(error).slice(0, 160) })
    try { ctx?.logger?.warn?.(`[redteam-mode] state persist failed: ${String(error).slice(0, 120)}`) } catch { /* no logger */ }
  }
  return state
}

/**
 * Move state captured under the pending bucket onto the real session key.
 * Called once the session id is known; a no-op when nothing was captured.
 */
export function migratePending(key, ctx) {
  if (key === PENDING_KEY) return null
  const pending = sessions.get(PENDING_KEY)
  if (!pending) return null
  const fresh = pending.state
  const meaningful = fresh.mode !== 'normal' || fresh.opsec_level !== 'balanced' || Boolean(fresh.objective)
  if (!meaningful) {
    sessions.delete(PENDING_KEY)
    return null
  }
  const entry = sessions.get(key) ?? (() => {
    const state = loadState(key)
    state.session_id = key
    const created = { state, key }
    sessions.set(key, created)
    return created
  })()
  entry.state.mode = fresh.mode
  entry.state.opsec_level = fresh.opsec_level
  entry.state.activation_seq = fresh.activation_seq ?? entry.state.activation_seq
  if (fresh.objective) entry.state.objective = fresh.objective
  sessions.delete(PENDING_KEY)
  persist(ctx, entry.state)
  hookTrace({ ev: 'pending-migrated', key, mode: entry.state.mode })
  return entry
}

/** Force-resolve the state key for a raw session id (commands, tools). */
export function entryForSessionId(sessionId) {
  return entryFor({ session: { id: sessionId } })
}
