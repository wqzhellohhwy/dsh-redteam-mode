/**
 * @dsh-external/dsh-redteam-mode — DSH-native port of codex-redteam-mode.
 *
 * Hook enforcement (Codex → DSH mapping):
 *   Codex SessionStart hook            → ctx.on('agent/session-start')
 *   Codex UserPromptSubmit hook        → ctx.on('agent/pre-step') waterfall
 *   Codex model_instructions_file      → activation message (contract + profile)
 *   Codex loopback rewrite proxy       → in-process pre-step rewrite (no network hop,
 *                                        no fabricated history — durable context instead)
 *   Codex stdio MCP runtime server     → native redteam_* tools (ctx.tools.register)
 *
 * Enforcement semantics preserved: mode commands are fullmatch-only; ordinary
 * development turns pass through untouched; security turns under an active
 * mode get the compiled Research Brief + operation dispatch injected as a
 * user-role message the model cannot skip (it is part of its own turn).
 */
import { parseModeCommand, parseOpsecCommand } from './parser.mjs'
import { processTurn, buildAuthorizationContext, buildRuntimeNotice } from './controller.mjs'
import { loadState, saveState, safeSessionKey } from './state.mjs'
import { loadProfileContent, loadModeContract, RESOURCES_DIR } from './profiles.mjs'
import { OperationRuntime } from './runtime/operations.mjs'
import { registerRedteamTools } from './tools.mjs'

export const name = '@dsh-external/dsh-redteam-mode'
export const inject = ['tools']

const INJECTED_KINDS = new Set([
  'redteam-brief',
  'redteam-mode',
  'instruction-hint',
  'skill-invocation',
  'context-snapshot',
])

function extractText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .map((block) => (typeof block === 'string' ? block : block?.type === 'text' ? block.text : ''))
    .join('')
}

function isUserAuthored(message) {
  if (!message || message.role !== 'user') return false
  return !INJECTED_KINDS.has(message.source?.kind)
}

export function apply(ctx, config = {}) {
  const options = {
    automationMode: config.automationMode ?? 'active',
    injectAuthorizationContext: config.injectAuthorizationContext ?? true,
    injectProfileOnActivation: config.injectProfileOnActivation ?? true,
  }

  /** sessionId → {state, key}; live objects so tools mutate + persist them. */
  const states = new Map()
  /** Deterministic dedup: brief ids derive from source message ids. */
  const seenMessages = new Set()
  let lastRoute = null
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try { ctx.logger?.warn?.(message) } catch { /* no logger */ }
  }

  // ── Model route capture (profile routing + LLM-assisted judge) ────────────
  ctx.on('llm/stream', (routeOptions, next) => {
    try {
      lastRoute = { provider: routeOptions.provider, model: routeOptions.model }
    } catch { /* observation only */ }
    return next()
  })

  const stateFor = (agent) => {
    const sid = String(agent?.session?.id ?? '')
    if (!sid) return null
    let entry = states.get(sid)
    if (!entry) {
      const key = safeSessionKey(sid)
      const loaded = loadState(key)
      loaded.session_id = key
      entry = { state: loaded, key }
      states.set(sid, entry)
    }
    return entry
  }

  const hooks = {
    getState(exec) {
      const entry = stateFor(exec?.agent)
      if (!entry) {
        // Agent-less execution (rare): fall back to a shared ephemeral state.
        const fallback = { state: loadState(''), key: '' }
        fallback.state.session_id = 'default'
        return fallback.state
      }
      return entry.state
    },
    persist(state) {
      try { saveState(state) } catch (error) { warnOnce(`redteam persist failed: ${String(error).slice(0, 80)}`) }
    },
  }

  // ── Session start: preload durable state ───────────────────────────────────
  ctx.on('agent/session-start', ({ agent } = {}) => {
    try {
      if (agent) stateFor(agent)
    } catch { /* preload is best-effort */ }
  })

  // ── The enforcement hook (≈ UserPromptSubmit) ─────────────────────────────
  ctx.on('agent/pre-step', async ({ agent } = {}, next) => {
    const decision = await next()
    try {
      if (!decision || decision.kind === 'reject' || !Array.isArray(decision.messages)) return decision
      const claimed = decision.messages.filter(isUserAuthored)
      let source = null
      for (let i = claimed.length - 1; i >= 0; i -= 1) {
        if (!seenMessages.has(claimed[i].id)) {
          source = claimed[i]
          break
        }
      }
      if (!source) return decision
      if (seenMessages.size > 1000) seenMessages.clear()

      const entry = stateFor(agent)
      if (!entry) return decision

      const text = extractText(source)
      seenMessages.add(source.id)
      const ackId = `redteam-mode-${source.id}`

      // 1) Mode command (fullmatch only — never mid-sentence).
      const modeCommand = parseModeCommand(text)
      if (modeCommand) {
        if (modeCommand === 'normal') {
          entry.state.mode = 'normal'
          entry.state.pending_action = {}
          entry.state.next_action_id = ''
          persist(entry.state)
          return appendMessage(decision, {
            id: ackId,
            text: '[mode] Red-team mode disabled. Normal engineering behavior restored.',
            kind: 'redteam-mode',
          })
        }
        entry.state.mode = modeCommand
        entry.state.activation_seq = (entry.state.activation_seq ?? 0) + 1
        persist(entry.state)
        const profile = options.injectProfileOnActivation
          ? loadProfileContent(lastRoute?.model ?? '')
          : { profile: '', filename: '', content: '' }
        const parts = [
          `[mode] Red-team mode ACTIVE (${modeCommand}). OPSEC=${entry.state.opsec_level}.`,
          options.injectAuthorizationContext ? buildAuthorizationContext(modeCommand) : '',
          loadModeContract(),
          profile.content ? `[model-prompt-profile]\nmodel=${lastRoute?.model ?? 'unknown'}; profile=${profile.profile}; file=${profile.filename}; scope=activation; authoritative=true\n${profile.content}` : '',
          buildRuntimeNotice(),
        ].filter(Boolean)
        return appendMessage(decision, { id: ackId, text: parts.join('\n\n'), kind: 'redteam-mode' })
      }

      // 2) OPSEC command.
      const opsecCommand = parseOpsecCommand(text)
      if (opsecCommand) {
        entry.state.opsec_level = opsecCommand
        persist(entry.state)
        return appendMessage(decision, {
          id: ackId,
          text: `[mode] OPSEC level updated to ${opsecCommand}.`,
          kind: 'redteam-mode',
        })
      }

      // 3) Normal mode → zero interference.
      if (entry.state.mode === 'normal') return decision

      // 4) Active mode → compile this turn through the controller.
      const result = processTurn({ prompt: text, state: entry.state, automationMode: options.automationMode })
      entry.state = result.state
      persist(result.state)
      if (result.kind === 'ordinary-development' && !result.overlay) return decision
      const composed = [result.brief, result.overlay].filter(Boolean).join('\n')
      if (!composed) return decision
      return appendMessage(decision, {
        id: `redteam-brief-${source.id}`,
        text: composed,
        kind: 'redteam-brief',
      })
    } catch (error) {
      warnOnce(`pre-step redteam hook failed (pass-through): ${String(error?.stack ?? error).slice(0, 160)}`)
      return decision
    }
  })

  const appendMessage = (decision, { id, text, kind }) => ({
    ...decision,
    messages: [
      ...decision.messages,
      {
        id,
        role: 'user',
        content: [{ type: 'text', text }],
        source: { kind, form: 'hint' },
      },
    ],
  })

  // ── Native runtime tools (≈ MCP server) ───────────────────────────────────
  const runtime = new OperationRuntime(ctx, {
    getRoute: () => lastRoute,
    getLlm: () => {
      try { return ctx.get?.('llm') } catch { return undefined }
    },
  })
  registerRedteamTools(ctx, runtime, hooks)

  ctx.logger?.info?.(`[${name}] active — resources at ${RESOURCES_DIR}`)
}
