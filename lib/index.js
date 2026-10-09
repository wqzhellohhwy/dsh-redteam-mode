/**
 * @dsh-external/dsh-redteam-mode — DSH 2.0 host/preset plugin.
 *
 * A hook-enforced red-team mode for DeepSeek Harness, ported from
 * codex-redteam-mode 2.1.0. Three enforcement surfaces, all mounted from
 * `apply` through owned effects so unloading the plugin removes every one:
 *
 *   1. Command plane  — `/redteam`, `/opsec` (ctx.commands.register):
 *                       instant mode switching, no model message, no tokens.
 *   2. Prompt contract— a dynamic system-prompt section that renders the mode
 *                       contract while the mode is active and renders EMPTY in
 *                       normal mode, so the plugin is invisible until used.
 *   3. Per-turn hook  — `agent/pre-step` waterfall: compiles each security
 *                       turn into a numbered Research Brief plus the durable
 *                       operation dispatch, and doubles as a text-command
 *                       fallback for surfaces without a command plane.
 *
 * Mount shapes (see `cordis.patch.yml`):
 *   host   — profile level: registers tools, commands, prompt section and a
 *            `{ global: true }` pre-step listener, so every session has the
 *            `/redteam` switch.
 *   preset — inside the `redteam` agent preset: registers the prompt contract
 *            and a scope-filtered listener, so selecting the preset starts a
 *            session already in red-team mode.
 */
import { OperationRuntime } from './runtime/operations.mjs'
import { registerRedteamTools } from './tools.mjs'
import { entryFor, persist } from './session.mjs'
import { registerRedteamCommands } from './commands.mjs'
import { MODE_SECTION_NAME, MODE_SECTION_ORDER, modeSectionText } from './prompt.mjs'
import { createAgentCreatedHandler, createPreStepHandler } from './hooks.mjs'
import { hookTrace } from './trace.mjs'
import { RESOURCES_DIR } from './profiles.mjs'

export const name = '@dsh-external/dsh-redteam-mode'

/** `tools` is the only hard requirement; everything else is composed optionally. */
export const inject = ['tools']

export function apply(ctx, config = {}) {
  const role = config.role === 'preset' ? 'preset' : 'host'
  const options = {
    role,
    defaultMode: config.defaultMode ?? (role === 'preset' ? 'redteam-full' : 'normal'),
    automationMode: config.automationMode ?? 'active',
    injectAuthorizationContext: config.injectAuthorizationContext !== false,
    injectProfileOnActivation: config.injectProfileOnActivation !== false,
    injectPromptSection: config.injectPromptSection !== false,
  }

  /** Model route observed from the LLM stream; feeds profile routing. */
  let lastRoute = null
  ctx.on('llm/stream', (routeOptions, next) => {
    try { lastRoute = { provider: routeOptions?.provider, model: routeOptions?.model } } catch { /* observation only */ }
    return next()
  })

  const api = {
    ctx,
    options,
    entryFor: (agent) => entryFor(agent),
    stateFor: (agent) => entryFor(agent).state,
    persist: (state) => persist(ctx, state),
    getRoute: () => lastRoute,
  }

  // ── 1. Prompt contract (dynamic; empty while the mode is normal) ──────────
  if (options.injectPromptSection) {
    ctx.inject(['systemPrompt'], (promptCtx) => {
      promptCtx.systemPrompt.section({
        name: MODE_SECTION_NAME,
        order: MODE_SECTION_ORDER,
        text: ({ agent }) => modeSectionText(entryFor(agent).state, { ...options, route: lastRoute }),
      })
      hookTrace({ ev: 'prompt-section-registered', role })
    })
  }

  // ── 2. Per-turn enforcement hook ─────────────────────────────────────────
  // The host mount must be `global`: `agent/pre-step` is dispatched with the
  // agent as scope carrier, and a listener registered outside that scope is
  // filtered out before running. The preset mount deliberately omits `global`
  // so the scope filter itself limits it to agents that selected the preset.
  const listenerOptions = role === 'host' ? { global: true } : {}
  ctx.on('agent/created', createAgentCreatedHandler(api), listenerOptions)
  ctx.on('agent/pre-step', createPreStepHandler(api), listenerOptions)

  // ── 3. Tools + command plane (host only; the preset inherits both) ───────
  if (role === 'host') {
    const runtime = new OperationRuntime(ctx, {
      getRoute: () => lastRoute,
      getLlm: () => {
        try { return ctx.get?.('llm') } catch { return undefined }
      },
    })
    registerRedteamTools(ctx, runtime, {
      getState: (exec) => entryFor(exec?.agent).state,
      persist: (state) => persist(ctx, state),
    })
    ctx.inject(['commands'], (commandCtx) => registerRedteamCommands(commandCtx, api))
  }

  hookTrace({ ev: 'plugin-mounted', role, resources: RESOURCES_DIR, defaultMode: options.defaultMode })
  try { ctx.logger?.info?.(`[${name}] mounted as ${role} — resources at ${RESOURCES_DIR}`) } catch { /* no logger */ }
}
