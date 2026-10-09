/**
 * Offline assembly + behaviour verification for @dsh-external/dsh-redteam-mode.
 *
 * Runs the real entry point against a minimal fake Cordis context, then drives
 * the registered `agent/pre-step` listener and the command handlers. It proves
 * the wiring (what got registered, where) and the enforcement semantics
 * (normal = untouched, active = injected) without needing a live harness.
 *
 * Usage:  node scripts/verify.mjs        (exit 0 = all checks passed)
 *
 * The real-harness check is `scripts/probe.mjs`, which inspects a live DSH
 * process; this file covers everything that can be proven offline.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Keep the run hermetic: state files must not touch the real profile.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'redteam-verify-'))
process.env.DSH_REDTEAM_TRACE = '0'

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

/** Minimal Cordis-shaped context: records every registration. */
function makeContext() {
  const hooks = new Map()
  const registered = { tools: [], commands: [], sections: [], effects: 0, listeners: [] }
  const ctx = {
    logger: { info() {}, warn() {}, error() {} },
    on(name, fn, options) {
      const list = hooks.get(name) ?? []
      list.push({ fn, options })
      hooks.set(name, list)
      registered.listeners.push({ name, options })
      return () => {}
    },
    effect(fn) {
      registered.effects += 1
      return fn()
    },
    inject(_deps, cb) {
      return cb(ctx)
    },
    get() {
      return undefined
    },
    tools: {
      register(definition) {
        registered.tools.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        registered.commands.push(definition)
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        registered.sections.push(section)
        return () => {}
      },
    },
  }
  return { ctx, hooks, registered }
}

const userMessage = (id, text) => ({
  id,
  role: 'user',
  content: [{ type: 'text', text }],
  source: { kind: 'user' },
})

async function main() {
  const mod = await import('../lib/index.js')
  check('entry exports name', mod.name === '@dsh-external/dsh-redteam-mode', mod.name)
  check('entry declares inject=[tools]', JSON.stringify(mod.inject) === '["tools"]')
  check('entry exports apply()', typeof mod.apply === 'function')

  // ── host mount ────────────────────────────────────────────────────────────
  const host = makeContext()
  mod.apply(host.ctx, { role: 'host' })
  check('host registers 5 redteam_* tools', host.registered.tools.length === 5, host.registered.tools.map((t) => t.name).join(','))
  check('host registers /redteam + /opsec', host.registered.commands.length === 2, host.registered.commands.map((c) => c.name).join(','))
  check('host registers the prompt contract section', host.registered.sections.length === 1, host.registered.sections[0]?.name)
  const preStepHooks = host.hooks.get('agent/pre-step') ?? []
  check('host registers exactly one agent/pre-step listener', preStepHooks.length === 1)
  check('host pre-step listener is global (scope filter proof)', preStepHooks[0]?.options?.global === true, JSON.stringify(preStepHooks[0]?.options))
  check('host registers agent/created (global)', (host.hooks.get('agent/created') ?? [])[0]?.options?.global === true)

  // ── preset mount ──────────────────────────────────────────────────────────
  const preset = makeContext()
  mod.apply(preset.ctx, { role: 'preset', defaultMode: 'redteam-full' })
  check('preset registers no duplicate tools', preset.registered.tools.length === 0)
  check('preset registers no duplicate commands', preset.registered.commands.length === 0)
  check('preset registers the contract section', preset.registered.sections.length === 1)
  const presetPreStep = (preset.hooks.get('agent/pre-step') ?? [])[0]
  check('preset pre-step listener is scope-filtered (not global)', presetPreStep !== undefined && presetPreStep.options?.global !== true, JSON.stringify(presetPreStep?.options ?? null))

  // ── prompt contract renders empty in normal mode ──────────────────────────
  const section = host.registered.sections[0]
  const agent = { session: { id: 'verify-session' } }
  check('contract section is empty while normal', section.text({ agent }) === '', JSON.stringify(section.text({ agent }).slice(0, 40)))

  // ── /redteam command plane ────────────────────────────────────────────────
  const redteam = host.registered.commands.find((c) => c.name === 'redteam')
  const first = await redteam.handler({ agent, rawInput: 'full' })
  check('/redteam full switches to redteam-full', first.kind === 'success' && first.text.includes('redteam-full'), first.text.split('\n')[0])
  check('contract section renders while active', section.text({ agent }).includes('[redteam-mode] ACTIVE'))
  const status = await redteam.handler({ agent, rawInput: 'status' })
  check('/redteam status reports the mode', status.text.includes('mode=redteam-full'))
  const objective = await redteam.handler({ agent, rawInput: '检查 http://demo.local 登录页 SQL 注入' })
  check('/redteam <objective> records the objective', objective.kind === 'success' && objective.text.includes('SQL 注入'))
  const opsec = host.registered.commands.find((c) => c.name === 'opsec')
  const opsecRes = await opsec.handler({ agent, rawInput: 'strict' })
  check('/opsec strict switches the level', opsecRes.kind === 'success' && opsecRes.text.includes('strict'))
  await opsec.handler({ agent, rawInput: 'balanced' })

  // ── enforcement hook: active mode injects, normal mode does not ───────────
  const preStep = host.hooks.get('agent/pre-step')[0].fn
  const activeDecision = { kind: 'enter', messages: [userMessage('msg-active-1', '继续验证登录接口的注入点')] }
  const activeOut = await preStep({ agent, messages: activeDecision.messages }, async () => activeDecision)
  const injected = activeOut.messages.filter((m) => m.source?.kind === 'redteam-brief')
  check('active mode injects exactly one brief', injected.length === 1, injected[0]?.content?.[0]?.text?.split('\n')[0])
  check('brief carries the workflow routing', String(injected[0]?.content?.[0]?.text).includes('[workflow:'))

  // Re-running the same turn must not double-inject: this is exactly what
  // happens when both the host and preset listeners sit on one waterfall.
  const secondOut = await preStep({ agent, messages: activeOut.messages }, async () => activeOut)
  check('re-processing the same turn is idempotent', secondOut.messages.filter((m) => m.source?.kind === 'redteam-brief').length === 1)

  // Ordinary development turns stay on the ordinary-development routing.
  const devDecision = { kind: 'enter', messages: [userMessage('msg-dev-1', '把 README 的中文段落改得更清楚')] }
  const devOut = await preStep({ agent, messages: devDecision.messages }, async () => devDecision)
  const devBrief = devOut.messages.find((m) => m.source?.kind === 'redteam-brief')
  check('ordinary turn is routed as ordinary-development', String(devBrief?.content?.[0]?.text).includes('ordinary-development'))

  // Text-command fallback (no command plane: headless / ACP).
  const fallbackAgent = { session: { id: 'verify-fallback' } }
  const fallbackDecision = {
    kind: 'enter',
    messages: [userMessage('msg-cmd-1', '/redteam full\n检查 api.demo.local 的越权访问')],
  }
  const fallbackOut = await preStep({ agent: fallbackAgent, messages: fallbackDecision.messages }, async () => fallbackDecision)
  const kinds = fallbackOut.messages.map((m) => m.source?.kind)
  check('text fallback activates the mode', kinds.includes('redteam-mode'), kinds.join(','))
  check('text fallback compiles the inline objective', kinds.includes('redteam-brief'), kinds.join(','))
  check(
    'text fallback keeps enforcing on later turns',
    (await preStep({ agent: fallbackAgent, messages: [userMessage('msg-cmd-2', '普通开发请求')] }, async () => ({
      kind: 'enter',
      messages: [userMessage('msg-cmd-2', '普通开发请求')],
    }))).messages.some((m) => m.source?.kind === 'redteam-brief'),
  )

  await redteam.handler({ agent: fallbackAgent, rawInput: 'off' })
  const offDecision = { kind: 'enter', messages: [userMessage('msg-off-1', '真的普通请求')] }
  const offOut = await preStep({ agent: fallbackAgent, messages: offDecision.messages }, async () => offDecision)
  check('normal mode passes the turn through untouched', offOut.messages.length === 1)
  check('contract section collapses again after /redteam off', section.text({ agent: fallbackAgent }) === '')

  // ── framework-authored user-role messages must not become objectives ──────
  await redteam.handler({ agent: fallbackAgent, rawInput: 'on' })
  const systemDecision = {
    kind: 'enter',
    messages: [userMessage('msg-sys-1', '<system-reminder>\nThe available skill catalog changed...\n</system-reminder>')],
  }
  const systemOut = await preStep({ agent: fallbackAgent, messages: systemDecision.messages }, async () => systemDecision)
  check('framework system-reminder is not compiled into an objective', systemOut.messages.length === 1, systemOut.messages.map((m) => m.source?.kind).join(','))
  const fallbackState = await redteam.handler({ agent: fallbackAgent, rawInput: 'status' })
  check('no garbage targets leaked into the state', !fallbackState.text.includes('available_skills'), fallbackState.text.replace(/\n/g, ' | '))

  // ── /redteam reset clears the session ─────────────────────────────────────
  const reset = await redteam.handler({ agent: fallbackAgent, rawInput: 'reset' })
  check('/redteam reset clears the mode and objective', reset.kind === 'success' && reset.text.includes('mode=normal'))

  // ── rejection safety ──────────────────────────────────────────────────────
  const rejectOut = await preStep({ agent }, async () => ({ kind: 'reject' }))
  check('a rejected decision is passed through unchanged', rejectOut.kind === 'reject')

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length) {
    console.error(`failed: ${failed.map((f) => f.name).join(' | ')}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('verify crashed:', error)
  process.exit(1)
})
