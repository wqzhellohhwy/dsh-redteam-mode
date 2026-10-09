/**
 * The enforcement hooks.
 *
 * DSH 2.0 events are scope-filtered: an `agent/pre-step` dispatch carries the
 * agent as its scope carrier, so a listener registered on a non-matching
 * context is dropped before it ever runs. Two mount shapes are therefore
 * supported here:
 *
 *   host   — mounted at the profile layer; registers with `{ global: true }`
 *            so the filter never drops it, giving every session the `/redteam`
 *            command plane and its per-turn enforcement.
 *   preset — mounted inside the redteam agent preset; registers WITHOUT
 *            `global`, so the scope filter itself restricts it to the agents
 *            that selected the preset.
 *
 * Both instances share the module-level `seen` set and the session cache, so a
 * turn is processed exactly once even when both are mounted.
 */
import { parseModeCommand, parseOpsecCommand } from './parser.mjs'
import { processTurn, buildAuthorizationContext, buildRuntimeNotice } from './controller.mjs'
import { loadModeContract, loadProfileContent } from './profiles.mjs'
import { hookTrace } from './trace.mjs'
import { migratePending } from './session.mjs'
import { isActiveMode } from './prompt.mjs'

/**
 * Message source kinds that are plugin/framework injections rather than user
 * input. Anything else on a user-role message is treated as authored text.
 */
const INJECTED_KINDS = new Set([
  'system-prompt',
  'model-selection',
  'user-approval',
  'ptc-mode',
  'tool-registry',
  'agent-message',
  'subagent-settled',
  'skill-invocation',
  'cordis-host-runner',
  'goal',
  'schedule',
  'compact-checkpoint',
  'session-reference',
  'user-question-reply',
  'runtime-context',
  'context-snapshot',
  'instruction-hint',
  'redteam-brief',
  'redteam-mode',
])

/** Deterministic dedup across this process: an id is enforced once. */
const seen = new Set()
const SEEN_LIMIT = 2000

/**
 * DSH delivers framework-authored material as user-role messages: skill-catalog
 * updates, goal-round continuations, workspace reminders. They are not user
 * input, and compiling one as a "security objective" produced garbage targets
 * (observed live: `[targets:/available_skills,/system-reminder]`), so they are
 * rejected before the intent engine ever sees them.
 */
const SYSTEM_WRAPPER_RE = /^\s*<(?:system-reminder|goal_round|goal-round|available_skills|skill_content|subagent-result)\b/i

export function extractText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''))
    .join('')
}

export function isUserAuthored(message) {
  if (!message || message.role !== 'user') return false
  if (INJECTED_KINDS.has(message.source?.kind)) return false
  return !SYSTEM_WRAPPER_RE.test(extractText(message))
}

function injectionMessage(id, text, kind) {
  return {
    id,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind, form: 'hint' },
  }
}

function appendMessage(decision, { id, text, kind }) {
  return { ...decision, messages: [...decision.messages, injectionMessage(id, text, kind)] }
}

function activationText(state, api) {
  const profile = api.options.injectProfileOnActivation === false
    ? { profile: '', filename: '', content: '' }
    : loadProfileContent(api.getRoute()?.model ?? '')
  return [
    `[mode] Red-team mode ACTIVE (${state.mode}). OPSEC=${state.opsec_level}.`,
    api.options.injectAuthorizationContext === false ? '' : buildAuthorizationContext(state.mode),
    loadModeContract(),
    profile.content
      ? `[model-prompt-profile]\nmodel=${api.getRoute()?.model ?? 'unknown'}; profile=${profile.profile}; file=${profile.filename}; scope=activation; authoritative=true\n${profile.content}`
      : '',
    buildRuntimeNotice(state),
  ].filter(Boolean).join('\n\n')
}

/** `agent/created` — preload durable state and migrate first-message captures. */
export function createAgentCreatedHandler(api) {
  return ({ agent } = {}) => {
    try {
      if (!agent) return
      const entry = api.entryFor(agent)
      if (entry.key !== '__pending__') migratePending(entry.key, api.ctx)
      if (api.options.role === 'preset' && !isActiveMode(entry.state.mode) && (entry.state.activation_seq ?? 0) === 0) {
        entry.state.mode = api.options.defaultMode
        entry.state.activation_seq = 1
        api.persist(entry.state)
        hookTrace({ ev: 'preset-default-mode', key: entry.key, mode: entry.state.mode })
      }
      hookTrace({ ev: 'agent-created', role: api.options.role, key: entry.key, mode: entry.state.mode })
    } catch (error) {
      hookTrace({ ev: 'agent-created-error', error: String(error).slice(0, 160) })
    }
  }
}

/** The `agent/pre-step` waterfall listener. */
export function createPreStepHandler(api) {
  return async function redteamPreStep(payload, next) {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const entry = api.entryFor(payload?.agent)
      const state = entry.state

      // Another instance (host + preset) already handled this turn.
      const alreadyInjected = decision.messages.some(
        (m) => m?.source?.kind === 'redteam-brief' || m?.source?.kind === 'redteam-mode',
      )
      hookTrace({
        ev: 'pre-step',
        role: api.options.role,
        key: entry.key,
        mode: state.mode,
        messages: decision.messages.length,
        alreadyInjected,
      })
      if (alreadyInjected) return decision

      // ── Text-command fallback ─────────────────────────────────────────────
      // Works without the UI command plane (headless / ACP runs). Fullmatch or
      // first-line only, so prose that merely mentions "redteam" never fires.
      for (const message of decision.messages) {
        if (!message || message.role !== 'user') continue
        const text = String(extractText(message) ?? '').trim()
        if (!text) continue
        if (SYSTEM_WRAPPER_RE.test(text)) continue

        const modeCommand = parseModeCommand(text)
        if (modeCommand) {
          if (modeCommand === 'normal') {
            state.mode = 'normal'
            state.pending_action = {}
            state.next_action_id = ''
            api.persist(state)
            hookTrace({ ev: 'text-command', key: entry.key, mode: 'normal' })
            return appendMessage(decision, {
              id: `redteam-mode-${message.id ?? 'x'}`,
              text: '[mode] Red-team mode disabled. Normal engineering behavior restored.',
              kind: 'redteam-mode',
            })
          }
          state.mode = modeCommand
          state.activation_seq = (state.activation_seq ?? 0) + 1
          const objectiveText = text.split(/\r?\n/).slice(1).join('\n').trim()
          if (objectiveText) state.objective = objectiveText
          api.persist(state)
          hookTrace({ ev: 'text-command', key: entry.key, mode: state.mode, objective: Boolean(objectiveText) })
          const activation = appendMessage(decision, {
            id: `redteam-mode-${message.id ?? 'x'}`,
            text: activationText(state, api),
            kind: 'redteam-mode',
          })
          if (!objectiveText) return activation
          const goalTurn = processTurn({ prompt: objectiveText, state, automationMode: api.options.automationMode })
          entry.state = goalTurn.state
          api.persist(entry.state)
          const composed = [goalTurn.brief, goalTurn.overlay].filter(Boolean).join('\n')
          if (!composed) return activation
          return appendMessage(activation, {
            id: `redteam-brief-${message.id ?? 'x'}`,
            text: composed,
            kind: 'redteam-brief',
          })
        }

        const opsecCommand = parseOpsecCommand(text)
        if (opsecCommand) {
          state.opsec_level = opsecCommand
          api.persist(state)
          hookTrace({ ev: 'text-command', key: entry.key, opsec: opsecCommand })
          return appendMessage(decision, {
            id: `redteam-mode-${message.id ?? 'x'}`,
            text: `[mode] OPSEC level updated to ${opsecCommand}.`,
            kind: 'redteam-mode',
          })
        }
      }

      // ── Normal mode: zero interference ────────────────────────────────────
      if (state.mode === 'normal') return decision

      // ── Active mode: compile this turn ────────────────────────────────────
      let source = null
      for (let i = decision.messages.length - 1; i >= 0; i -= 1) {
        const candidate = decision.messages[i]
        if (!isUserAuthored(candidate)) continue
        if (seen.has(candidate.id)) continue
        source = candidate
        break
      }
      if (!source) return decision
      if (seen.size > SEEN_LIMIT) seen.clear()
      seen.add(source.id)

      const prompt = extractText(source)
      const result = processTurn({ prompt, state, automationMode: api.options.automationMode })
      entry.state = result.state
      api.persist(entry.state)
      const composed = [result.brief, result.overlay].filter(Boolean).join('\n')
      if (!composed) return decision
      hookTrace({ ev: 'brief-injected', key: entry.key, mode: entry.state.mode, kind: result.kind })
      return appendMessage(decision, {
        id: `redteam-brief-${source.id}`,
        text: composed,
        kind: 'redteam-brief',
      })
    } catch (error) {
      hookTrace({ ev: 'pre-step-error', error: String(error?.stack ?? error).slice(0, 300) })
      try { api.ctx?.logger?.warn?.(`[redteam-mode] pre-step hook failed (pass-through): ${String(error).slice(0, 140)}`) } catch { /* no logger */ }
      return decision
    }
  }
}
