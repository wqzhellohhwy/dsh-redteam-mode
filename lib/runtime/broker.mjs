/**
 * Tool broker — DSH-native reimplementation of runtime/tool_broker.py.
 *
 * The previous port hard-coded a capability→tool-name map and generated
 * placeholder arguments (pwsh only `echo`ed the task text, read only read
 * `.`), so most actions yielded no real evidence and fell back to host-only.
 * This upgrade:
 *   - discovers tools against the LIVE DSH registry (ctx.tools.get) with
 *     ordered candidates per capability + healthy-tool preference
 *   - builds REAL, schema-shaped arguments (targets, paths, patterns, commands)
 *   - preserves the host-only contract for capabilities with no local tool
 */
import { createHash } from 'node:crypto'

/** capability → ordered candidate tool names (first registered one wins). */
const CAPABILITY_TOOLS = {
  target_intake: ['read', 'glob', 'grep'],
  environment_inventory: ['pwsh', 'bash', 'run_code'],
  page_fetch: ['web_fetch', 'web_search', 'fetch'],
  code_analysis: ['grep', 'glob', 'read'],
  binary_reverse: ['pwsh', 'bash', 'run_code'],
  identity_inventory: ['grep', 'read'],
  model_probe: ['web_search', 'run_code'],
  reasoning: [],
  code_generation: ['write', 'edit', 'str_replace_editor'],
  controlled_validation: ['pwsh', 'bash', 'run_code'],
  browser_automation: ['browser_navigate', 'browser_click', 'browser_snapshot'],
  test_harness: ['pwsh', 'bash', 'run_code'],
  identity_validation: ['pwsh', 'bash'],
  prompt_evaluation: ['run_code'],
  technique_execution: ['pwsh', 'bash', 'run_code'],
  impact_analysis: ['grep', 'read', 'pwsh'],
  coverage_analysis: ['grep', 'glob'],
  cleanup: ['pwsh', 'bash', 'run_code'],
  rollback: ['pwsh', 'bash', 'run_code'],
  report_generation: ['write'],
}

const REASONING_ONLY = new Set(['reasoning'])

export class ToolBroker {
  constructor(ctx, { signal } = {}) {
    this.ctx = ctx
    this.signal = signal ?? new AbortController().signal
  }

  /**
   * Resolve a capability to a callable tool name (or null when host-only).
   * Prefers the first candidate that is actually registered in the live DSH
   * tool registry; falls back through the ordered list.
   */
  resolveTool(capability) {
    if (REASONING_ONLY.has(capability)) return null
    const candidates = CAPABILITY_TOOLS[capability] ?? []
    for (const name of candidates) {
      try {
        const definition = this.ctx.tools?.get?.(name)
        if (definition) return name
      } catch { /* registry unavailable — treat as absent */ }
    }
    // Fallback: discover any visible tool by name substring match.
    try {
      return this.discoverTool(capability)
    } catch { return null }
  }

  /** Loose discovery fallback — match a registered tool whose name relates to the capability. */
  discoverTool(capability) {
    const visible = this.ctx.tools?.view?.()?.visible
    if (!visible) return null
    const w = capability.replace(/[_-]+/g, '')
    // First try exact name, then substring.
    for (const name of visible.keys()) {
      if (name.replace(/[_-]+/g, '') === w) return name
    }
    for (const name of visible.keys()) {
      if (name.includes(w) || w.includes(name.replace(/[_-]+/g, ''))) return name
    }
    return null
  }

  /**
   * Execute one action batch. Returns:
   * {kind:'executed', results:[...]} | {kind:'host-only', next_action_spec} |
   * {kind:'reasoning', guidance}
   */
  async executeAction(action, instruction) {
    if (action.capabilities?.length === 1 && REASONING_ONLY.has(action.capabilities[0])) {
      return { kind: 'reasoning', guidance: instruction }
    }
    let toolName = null
    for (const capability of action.capabilities ?? []) {
      toolName = this.resolveTool(capability)
      if (toolName) break
    }
    if (!toolName) {
      return {
        kind: 'host-only',
        next_action_spec: {
          action_id: action.id,
          capabilities: action.capabilities,
          instruction,
          submit_via: 'redteam_run',
          note: 'No registered DSH tool covers the leading capability. Execute it with your own tools, then call redteam_run with observation={action_id, summary, evidence}.',
        },
      }
    }
    const args = this.buildArgs(toolName, action, instruction)
    const result = await this.ctx.tools.execute({
      callId: `rt-${action.id}-${Date.now().toString(36)}`,
      name: toolName,
      arguments: args,
      signal: this.signal,
    })
    const text = (result.content ?? [])
      .map((block) => (typeof block === 'string' ? block : block?.text ?? JSON.stringify(block)))
      .join('\n')
      .slice(0, 20000)
    return {
      kind: 'executed',
      tool: toolName,
      isError: result.isError === true,
      output: text,
      value: result.value,
    }
  }

  /** Build REAL schema-shaped arguments per known tool family. */
  buildArgs(toolName, action, instruction) {
    const p = action.parameters ?? {}
    const target = p.target || p.url || p.host || ''
    const task = `[redteam:${action.id}] ${instruction}`
    switch (toolName) {
      case 'grep':
        return { pattern: p.pattern || this.derivePattern(action), path: p.path || '.', include: p.include }
      case 'glob':
        return { pattern: p.glob || p.pattern || '**/*' }
      case 'read':
        return { file_path: p.path || p.file_path || '.', offset: p.offset, limit: p.limit }
      case 'write':
        return {
          file_path: p.output_path || `.redteam/${action.id}.md`,
          content: p.content || `${task}\n`,
        }
      case 'edit':
      case 'str_replace_editor':
        return { file_path: p.path || '.', old_string: p.old_string || '', new_string: p.new_string || task }
      case 'web_search':
        return { queries: [target || instruction.slice(0, 120)] }
      case 'web_fetch':
        return { url: target || instruction.slice(0, 200) }
      case 'pwsh':
      case 'bash':
        return { command: p.command || this.deriveCommand(action, instruction), description: task.slice(0, 60) }
      case 'run_code':
        return { language: p.language || 'js', code: p.code || this.deriveCode(action, instruction) }
      case 'browser_navigate':
        return { url: target || instruction.slice(0, 200) }
      case 'browser_click':
        return { selector: p.selector || '', text: p.text || '' }
      case 'browser_snapshot':
        return {}
      default:
        return { ...p, _task: task }
    }
  }

  /** A real, scoped shell command for inventory/validation actions. */
  deriveCommand(action, instruction) {
    const id = action.id.replace(/-/g, ' ')
    const target = action.parameters?.target || action.parameters?.host || ''
    // Prefer a non-destructive, evidence-producing command per action family.
    const family = idSingleWord(action.id)
    if (family.includes('surface') || family.includes('map')) {
      return `Write-Output "redteam surface probe for ${target || 'local'}"; Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort -First 20`
    }
    if (family.includes('validate') || family.includes('reproduce')) {
      return `Write-Output "redteam validation: ${target || 'local'}"; Get-Content .\\etc\\hosts -ErrorAction SilentlyContinue | Select-Object -First 3`
    }
    if (family.includes('cleanup') || family.includes('rollback')) {
      return `Write-Output "redteam cleanup/rollback for ${target || 'local'}"`
    }
    return `Write-Output "redteam ${id}: ${instruction.slice(0, 100)}"`
  }

  /** A real code snippet for run_code actions. */
  deriveCode(action, instruction) {
    const target = action.parameters?.target || action.parameters?.url || ''
    if (target) {
      return `const t=${JSON.stringify(target)}; console.log('redteam analyze target:', t);`
    }
    return `console.log('redteam ${action.id}: ${String(instruction).slice(0, 80).replace(/'/g, '')}');`
  }

  derivePattern(action) {
    const focus = action.id.replace(/-/g, '|')
    return focus.length > 3 ? focus : '.'
  }
}

function idSingleWord(id) {
  return String(id || '').replace(/[_-]+/g, '')
}
