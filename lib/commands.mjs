/**
 * `/redteam` and `/opsec` slash commands (DSH 2.0 command plane).
 *
 * Commands run directly against the receiving agent and produce no model
 * message, so a mode switch is instant and costs no tokens. The mode contract
 * reaches the model through the dynamic prompt section (see `prompt.mjs`), and
 * per-turn work is driven by the `agent/pre-step` hook.
 */
import { hookTrace } from './trace.mjs'

export const REDTEAM_COMMAND = 'redteam'
export const OPSEC_COMMAND = 'opsec'

export const COMMAND_HELP = [
  '红队模式（仅限已授权安全测试）：',
  '  /redteam on | light      开启红队模式（轻量）',
  '  /redteam full            开启红队模式（完全态）',
  '  /redteam off             关闭，恢复正常工程行为',
  '  /redteam status          查看模式 / OPSEC / 操作进度',
  '  /redteam reset           重置本会话红队状态（清空目标）',
  '  /redteam <目标描述>       开启完全态并把该描述作为本次安全目标',
  '  /opsec strict|balanced   切换 OPSEC 级别',
].join('\n')

function statusText(state) {
  const lines = [
    `mode=${state.mode}`,
    `opsec=${state.opsec_level}`,
    `session=${state.session_id}`,
  ]
  if (state.objective) lines.push(`objective=${state.objective}`)
  if (state.operation_run_id) lines.push(`run_id=${state.operation_run_id}`)
  if (state.operation_status) lines.push(`operation_status=${state.operation_status}`)
  const pending = state.pending_action && Object.keys(state.pending_action).length > 0
  lines.push(`pending_action=${pending ? 'yes' : 'no'}`)
  return lines.join('\n')
}

/**
 * Apply one `/redteam` command line to a session state.
 * @returns {{ok: boolean, text: string}}
 */
export function applyRedteamCommand(state, rawInput) {
  const text = String(rawInput ?? '').trim()
  if (text === '') {
    return { ok: true, text: `${statusText(state)}\n\n${COMMAND_HELP}` }
  }
  const [head, ...rest] = text.split(/\s+/)
  const verb = head.toLowerCase()
  const restText = rest.join(' ').trim()

  if (verb === 'status' || verb === 'show') return { ok: true, text: `${statusText(state)}\n\n${COMMAND_HELP}` }

  if (verb === 'off' || verb === 'disable' || verb === 'normal') {
    state.mode = 'normal'
    state.pending_action = {}
    state.next_action_id = ''
    state.operation_status = state.operation_status === 'dispatch_pending' ? 'paused' : state.operation_status
    return { ok: true, text: `红队模式已关闭（mode=normal）。日常工程行为已恢复。\n${statusText(state)}` }
  }

  if (verb === 'reset') {
    state.mode = 'normal'
    state.objective = ''
    state.pending_action = {}
    state.next_action_id = ''
    state.operation_run_id = ''
    state.operation_status = ''
    state.goal_terminal = false
    state.goal_success = false
    state.verified_artifacts = []
    return { ok: true, text: `本会话红队状态已重置（mode=normal，目标清空）。\n${statusText(state)}` }
  }

  if (verb === 'on' || verb === 'light' || verb === 'enable') {
    state.mode = 'redteam-light'
    state.activation_seq = (state.activation_seq ?? 0) + 1
    if (restText) state.objective = restText
    return { ok: true, text: `红队模式已开启（mode=redteam-light, opsec=${state.opsec_level}）。\n${statusText(state)}` }
  }

  if (verb === 'full') {
    state.mode = 'redteam-full'
    state.activation_seq = (state.activation_seq ?? 0) + 1
    if (restText) state.objective = restText
    return { ok: true, text: `红队模式已开启（mode=redteam-full, opsec=${state.opsec_level}）。\n${statusText(state)}` }
  }

  if (verb === 'opsec') {
    const level = restText.toLowerCase()
    if (level !== 'strict' && level !== 'balanced') {
      return { ok: false, text: `未知 OPSEC 级别 "${restText}"。用法：/redteam opsec strict|balanced` }
    }
    state.opsec_level = level
    return { ok: true, text: `OPSEC 级别已切换为 ${level}。` }
  }

  if (verb === 'help' || verb === '-h' || verb === '--help') return { ok: true, text: COMMAND_HELP }

  // Anything else is the security objective itself: activate the full mode and
  // carry the text as this session's objective.
  state.mode = 'redteam-full'
  state.activation_seq = (state.activation_seq ?? 0) + 1
  state.objective = text
  state.goal_terminal = false
  state.goal_success = false
  state.pending_action = {}
  return {
    ok: true,
    text: `红队模式已开启（mode=redteam-full），目标已记录：\n${text}\n\n下一步：直接发送消息描述你要做的验证，或让助手按目标开工。\n${statusText(state)}`,
  }
}

/**
 * Register the command plane. Mounted through `ctx.inject(['commands'])` so a
 * profile without the command service simply skips it.
 */
export function registerRedteamCommands(ctx, api) {
  const commands = ctx.commands
  const register = (definition) =>
    ctx.effect(() => commands.register(definition), `redteam-mode: /${definition.name}`)

  register({
    name: REDTEAM_COMMAND,
    description: '红队模式开关：/redteam on|light|full|off|status|reset|<目标描述>',
    input: { hint: 'on | light | full | off | status | reset | opsec strict|balanced | <目标描述>' },
    handler: ({ agent, rawInput }) => {
      const state = api.stateFor(agent)
      const result = applyRedteamCommand(state, rawInput)
      api.persist(state)
      hookTrace({ ev: 'command', command: REDTEAM_COMMAND, input: String(rawInput ?? '').slice(0, 120), mode: state.mode, ok: result.ok })
      return { kind: result.ok ? 'success' : 'error', text: result.text }
    },
  })

  register({
    name: OPSEC_COMMAND,
    description: '红队 OPSEC 级别：/opsec strict|balanced',
    input: { hint: 'strict | balanced' },
    handler: ({ agent, rawInput }) => {
      const state = api.stateFor(agent)
      const level = String(rawInput ?? '').trim().toLowerCase()
      if (level !== 'strict' && level !== 'balanced') {
        return { kind: 'error', text: `未知 OPSEC 级别 "${level}"。用法：/opsec strict|balanced` }
      }
      state.opsec_level = level
      api.persist(state)
      hookTrace({ ev: 'command', command: OPSEC_COMMAND, input: level, mode: state.mode, ok: true })
      return { kind: 'success', text: `OPSEC 级别已切换为 ${level}（mode=${state.mode}）。` }
    },
  })
}
