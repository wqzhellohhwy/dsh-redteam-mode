/**
 * Tool broker — DSH-native reimplementation of runtime/tool_broker.py.
 * Instead of discovering MCP servers over stdio, it resolves capabilities
 * against the LIVE DSH tool registry (ctx.tools.get / schemas) and dispatches
 * through ctx.tools.execute in-process. Capabilities with no local tool
 * surface as host-only actions (next_action_spec handoff), preserving the
 * original Host Agent contract.
 */

/** capability → ordered candidate tool names (first registered one wins). */
const CAPABILITY_TOOLS = {
  target_intake: ['read', 'glob', 'grep'],
  environment_inventory: ['pwsh', 'bash', 'run_code'],
  page_fetch: ['web_fetch', 'fetch', 'web_search'],
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

  /** Resolve a capability to a callable tool name (or null when host-only). */
  resolveTool(capability) {
    if (REASONING_ONLY.has(capability)) return null
    const candidates = CAPABILITY_TOOLS[capability] ?? []
    for (const name of candidates) {
      try {
        const definition = this.ctx.tools?.get?.(name)
        if (definition) return name
      } catch {
        // Registry unavailable — treat as absent.
      }
    }
    return null
  }

  /**
   * Execute one action batch. Returns:
   * {kind:'executed', results:[...]} | {kind:'host-only', next_action_spec} |
   * {kind:'reasoning', guidance}
   */
  async executeAction(action, instruction) {
    const toolName = this.resolveTool(action.capabilities?.[0])
    if (action.capabilities?.length === 1 && REASONING_ONLY.has(action.capabilities[0])) {
      return { kind: 'reasoning', guidance: instruction }
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
      value: result.isError ? undefined : result.value,
    }
  }

  /** Shape minimal arguments per known tool family; tools validate their own schemas. */
  buildArgs(toolName, action, instruction) {
    const task = `[redteam:${action.id}] ${instruction}`
    switch (toolName) {
      case 'grep':
        return { pattern: this.derivePattern(action), path: '.', include: undefined, _task: task }
      case 'glob':
        return { pattern: '**/*' }
      case 'read':
        return { file_path: action.parameters?.path ?? '.' }
      case 'write':
        return { file_path: action.parameters?.output_path ?? `.redteam/${action.id}.md`, content: task + '\n' }
      case 'web_search':
        return { queries: [instruction.slice(0, 120)] }
      case 'pwsh':
      case 'bash':
        return { command: `echo "${task.replace(/"/g, "'")}"`, description: task.slice(0, 60) }
      default:
        return { task }
    }
  }

  derivePattern(action) {
    const focus = action.id.replace(/-/g, '|')
    return focus.length > 3 ? focus : '.'
  }
}
