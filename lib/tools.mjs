/**
 * redteam_* tool surface — DSH-native replacement of the stdio MCP server
 * (runtime/mcp_server.py). Tools are short-schema (prefill cost discipline):
 * details live in tool results, not descriptions.
 *
 * Every tool's `parameters` is a full JSON Schema with a top-level
 * `type: 'object'` + `properties`. This is REQUIRED by DeepSeek's official
 * API validator (a flat {name:{type,...}} shape caused
 * "schema must be a JSON Schema of 'type: object', got 'type: null'"). Use
 * `scripts/schema.mjs` to re-verify the projection any time a tool changes.
 *
 * Schemas are exported as pure data (redteamToolSchemas) so tests can assert
 * the projection without a host; the `execute` closures are attached inside
 * `registerRedteamTools` where `runtime`/`hooks` are in scope.
 *
 * Session binding: every execute receives the registry's ToolRunContext
 * (`exec`); the session id comes from exec.agent.session.id so parallel
 * sessions never share state.
 */
import { findActiveOperation, appendEvent } from './runtime/store.mjs'

const output = { schema: { type: 'object' }, render: (_a, v) => [{ type: 'text', text: JSON.stringify(v, null, 2) }] }

/** Pure schema data — asserted by scripts/schema.mjs. */
export const redteamToolSchemas = [
  {
    name: 'redteam_run',
    description: 'Start/resume/advance the durable red-team operation. One call = one evidence batch.',
    parameters: {
      type: 'object',
      properties: {
        objective: { type: 'string', description: 'New security objective (starts an operation when given)' },
        targets: { type: 'array', items: { type: 'string' }, description: 'Optional explicit targets' },
        run_id: { type: 'string', description: 'Resume this operation instead of starting' },
        observation: {
          type: 'object',
          description: 'Host-agent result for a pending action: {action_id, summary, evidence}',
          properties: {
            action_id: { type: 'string', description: 'action id' },
            summary: { type: 'string', description: 'one-paragraph result' },
            evidence: { type: 'string', description: 'raw tool-derived evidence' },
          },
          required: ['action_id', 'summary'],
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'redteam_status',
    description: 'Current mode state + operation progress for this session.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'redteam_evidence',
    description: 'Dump the evidence graph of one operation (default: active).',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Operation id (default: active operation)' },
      },
    },
  },
  {
    name: 'redteam_cancel',
    description: 'Cancel an operation and freeze its ledger.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Operation id' },
        reason: { type: 'string', description: 'Why' },
      },
      required: ['run_id'],
    },
  },
  {
    name: 'redteam_events',
    description: 'Append-only event tail of one operation.',
    parameters: {
      type: 'object',
      properties: {
        run_id: { type: 'string', description: 'Operation id' },
        tail: { type: 'number', description: 'Last N events (default 50)' },
      },
      required: ['run_id'],
    },
  },
]

/** Build the full tool definitions, attaching execute closures. */
function buildTools(runtime, hooks) {
  const { getState, persist } = hooks

  return [
    {
      ...redteamToolSchemas[0],
      output,
      async execute(args, exec) {
        const state = getState(exec)
        const sessionKey = state.session_id || 'default'
        let op = null

        if (args.observation?.action_id) {
          op = args.run_id ? runtime.resume(args.run_id) : findActiveOperation(sessionKey)
          if (!op) throw new Error('no active operation for observation; pass run_id or start with objective')
          runtime.submitObservation(op, args.observation)
        }

        if (!op && args.run_id) {
          op = runtime.resume(args.run_id)
          if (!op) throw new Error(`operation not found: ${args.run_id}`)
        }
        if (!op && args.objective) {
          op = runtime.start({
            sessionKey,
            objective: args.objective,
            targets: args.targets,
            opsecLevel: state.opsec_level,
          })
          state.operation_run_id = op.run_id
          if (!state.operation_run_ids.includes(op.run_id)) state.operation_run_ids.push(op.run_id)
          state.workflow_id = 'generic-adaptive'
          state.operation_status = 'running'
          persist(state)
          try { appendEvent(op.run_id, 'state/linked', { session: sessionKey }) } catch { /* best-effort */ }
        }
        if (!op) op = findActiveOperation(sessionKey)
        if (!op) {
          return { state: 'idle', note: 'No active operation. Provide objective to start one, or run_id to resume.' }
        }
        return await runtime.runBatch(op)
      },
    },
    {
      ...redteamToolSchemas[1],
      output,
      async execute(_args, exec) {
        const state = getState(exec)
        const ops = runtime.list(state.session_id || '', 5).map((op) => ({
          run_id: op.run_id,
          status: op.status,
          objective: op.contract?.objective ?? '',
          completed_actions: op.completed_actions ?? [],
          artifacts_verified: Object.fromEntries(Object.entries(op.artifacts ?? {}).map(([k, v]) => [k, v.verified === true])),
        }))
        return {
          mode: state.mode,
          opsec_level: state.opsec_level,
          objective: state.objective,
          goal_terminal: state.goal_terminal,
          goal_success: state.goal_success,
          operation_run_id: state.operation_run_id,
          operations: ops,
        }
      },
    },
    {
      ...redteamToolSchemas[2],
      output,
      async execute(args, exec) {
        const state = getState(exec)
        const op = args.run_id ? runtime.resume(args.run_id) : findActiveOperation(state.session_id || '')
        if (!op) return { error: 'no operation found' }
        return {
          run_id: op.run_id,
          contract: op.contract.objective,
          completed_actions: op.completed_actions,
          artifacts: op.artifacts,
          evidence: op.evidence.map((node) => ({ ...node, content: node.content?.slice(0, 2000) })),
        }
      },
    },
    {
      ...redteamToolSchemas[3],
      output,
      async execute(args, exec) {
        const op = runtime.resume(args.run_id)
        if (!op) throw new Error(`operation not found: ${args.run_id}`)
        runtime.cancel(op, args.reason || 'user-requested')
        const state = getState(exec)
        if (state.operation_run_id === op.run_id) {
          state.goal_terminal = true
          state.goal_success = false
          persist(state)
        }
        return { cancelled: op.run_id, status: op.status }
      },
    },
    {
      ...redteamToolSchemas[4],
      output,
      async execute(args) {
        return { run_id: args.run_id, events: runtime.events(args.run_id, args.tail ?? 50) }
      },
    },
  ]
}

export function registerRedteamTools(ctx, runtime, hooks) {
  const register = (definition, label) => {
    ctx.effect(() => ctx.tools.register(definition), label)
  }
  for (const tool of buildTools(runtime, hooks)) {
    register(tool, `@dsh-redteam-mode: ${tool.name}`)
  }
}
