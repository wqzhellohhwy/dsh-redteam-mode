/**
 * Operation runtime facade — condensed port of runtime/operation_runtime.py +
 * adaptive_planner.py + mcp_server.py tool surface.
 *
 * One redteamRun() call advances the operation by ONE batch:
 *   ready action → broker dispatch (in-process DSH tools) → evidence node →
 *   next action … until a host-only handoff, the terminal judge passing, or
 *   the batch cap. Host-only actions return next_action_spec for the host
 *   agent; observations arrive back through redteam_run({observation}).
 */
import { GENERIC_ADAPTIVE, readyActions } from './workflow.mjs'
import { compileGoal } from './goal.mjs'
import { ToolBroker } from './broker.mjs'
import { SemanticJudge } from './judge.mjs'
import { newEvidenceNode, addEvidence, markVerified, summarizeGraph } from './evidence.mjs'
import { saveOperation, loadOperation, appendEvent, readEvents, newRunId, findActiveOperation, listOperations } from './store.mjs'

const MAX_BATCH_ACTIONS = 3

export class OperationRuntime {
  constructor(ctx, { getRoute, getLlm } = {}) {
    this.ctx = ctx
    this.getRoute = getRoute // live route accessor (llm/stream capture)
    this.getLlm = getLlm // opportunistic llm service resolver
  }

  start({ sessionKey, objective, targets, constraints, opsecLevel }) {
    const contract = compileGoal(objective, {
      targets: targets?.length ? targets : undefined,
      startingContext: {},
      constraints: { ...(constraints ?? {}), opsec_level: opsecLevel },
    })
    const runId = newRunId(sessionKey)
    const op = {
      run_id: runId,
      session_key: sessionKey,
      status: 'running',
      contract,
      workflow: 'generic-adaptive',
      completed_actions: [],
      failed_actions: {},
      evidence: [],
      artifacts: {},
      observations: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      aborted: false,
    }
    saveOperation(op)
    appendEvent(runId, 'operation/start', { objective: contract.objective, targets: contract.targets })
    return op
  }

  resume(runId) {
    return loadOperation(runId) ?? findActiveOperation('')
  }

  /** Record one host-agent observation and attach it as evidence. */
  submitObservation(op, { actionId, summary, content }) {
    const node = addEvidence(op, newEvidenceNode({
      kind: this.inferKind(actionId),
      actionId,
      summary,
      content,
      meta: { source: 'host-observation' },
    }))
    if (!op.completed_actions.includes(actionId)) op.completed_actions.push(actionId)
    op.observations.push({ action_id: actionId, at: node.created_at, summary })
    appendEvent(op.run_id, 'observation/submit', { actionId, summary })
    return node
  }

  inferKind(actionId) {
    switch (actionId) {
      case 'map-surface': return 'surface_map'
      case 'build-hypotheses': return 'hypothesis_queue'
      case 'validate-path': return 'reproduction_artifact'
      case 'prove-impact': return 'impact_proof'
      case 'review-coverage': return 'coverage_report'
      case 'cleanup': return 'cleanup_proof'
      case 'report': return 'final_report'
      default: return 'surface_map'
    }
  }

  /**
   * Advance one batch. Returns a structured result for redteam_run.
   */
  async runBatch(op, { batchLimit = MAX_BATCH_ACTIONS } = {}) {
    if (op.status === 'completed' || op.status === 'cancelled') {
      return { state: op.status, run_id: op.run_id, note: `operation already ${op.status}` }
    }
    op.status = 'running'
    const spec = GENERIC_ADAPTIVE
    let executed = 0

    while (executed < batchLimit) {
      // Terminal gate first: cheap to check, decides completion.
      const judge = new SemanticJudge({ getRoute: this.getRoute, getLlm: this.getLlm })
      const verdict = await judge.judgeTerminal(op, spec, op.contract.objective)
      if (verdict.terminal) {
        op.status = 'completed'
        op.goal_terminal = true
        op.goal_success = verdict.success
        op.updated_at = new Date().toISOString()
        saveOperation(op)
        appendEvent(op.run_id, 'operation/terminal', { success: verdict.success })
        return {
          state: 'completed',
          run_id: op.run_id,
          goal_success: verdict.success,
          unmet: verdict.unmet,
          artifacts: Object.fromEntries(Object.entries(op.artifacts).map(([k, v]) => [k, v.verified])),
          evidence_summary: summarizeGraph(op),
          final_report: op.artifacts.final_report?.evidence_ids ?? [],
        }
      }
      if (op.aborted) break

      const pending = readyActions(spec, op.completed_actions).filter((action) => !op.failed_actions[action.id] || op.failed_actions[action.id] < 2)
      if (pending.length === 0) {
        op.status = 'blocked'
        op.updated_at = new Date().toISOString()
        saveOperation(op)
        appendEvent(op.run_id, 'operation/blocked', {})
        return {
          state: 'blocked',
          run_id: op.run_id,
          note: 'No ready actions (all failed twice or dependency cycle). Provide an observation or revise the objective.',
          unmet: verdict.unmet,
        }
      }

      const action = pending[0]
      const instruction = this.composeInstruction(op, action, spec)
      const broker = new ToolBroker(this.ctx)
      let outcome
      try {
        outcome = await broker.executeAction(action, instruction)
      } catch (error) {
        outcome = { kind: 'executed', isError: true, output: String(error), tool: '(dispatch)' }
      }

      if (outcome.kind === 'host-only') {
        op.pending_host_action = outcome.next_action_spec
        op.updated_at = new Date().toISOString()
        saveOperation(op)
        appendEvent(op.run_id, 'action/host-only', { actionId: action.id })
        return {
          state: 'pending-host-action',
          run_id: op.run_id,
          next_action_spec: outcome.next_action_spec,
          note: 'Execute next_action_spec with your own tools, then call redteam_run with observation={action_id, summary, evidence}.',
        }
      }

      const kind = this.inferKind(action.id)
      addEvidence(op, newEvidenceNode({
        kind,
        actionId: action.id,
        summary: `${action.name} via ${outcome.tool ?? 'reasoning'}${outcome.isError ? ' (error)' : ''}`,
        content: outcome.kind === 'reasoning' ? `(reasoning step) ${outcome.guidance}` : outcome.output?.slice(0, 8000),
        meta: outcome.isError ? { error: true } : {},
      }))
      if (outcome.isError || outcome.kind !== 'executed') {
        op.failed_actions[action.id] = (op.failed_actions[action.id] ?? 0) + 1
        if ((op.failed_actions[action.id] ?? 0) >= 2 && outcome.isError) {
          // Two strikes on an errored dispatch — leave it to the host agent.
          op.pending_host_action = {
            action_id: action.id,
            instruction,
            capabilities: action.capabilities,
            submit_via: 'redteam_run',
            note: 'In-process dispatch failed twice. Execute manually and submit an observation.',
          }
        }
      } else {
        op.completed_actions.push(action.id)
        delete op.failed_actions[action.id]
        if (kind === 'final_report') markVerified(op, kind, 'auto:generated')
      }
      appendEvent(op.run_id, 'action/settle', { actionId: action.id, ok: !outcome.isError, tool: outcome.tool ?? outcome.kind })
      executed += 1
    }

    op.updated_at = new Date().toISOString()
    saveOperation(op)
    return {
      state: 'running',
      run_id: op.run_id,
      completed: [...op.completed_actions],
      note: 'Batch cap reached. Call redteam_run again to continue.',
      evidence_summary: summarizeGraph(op),
    }
  }

  composeInstruction(op, action, spec) {
    const focus = action.parameters?.coverage_focus ?? action.parameters?.validation_contract ?? action.parameters?.prioritization ?? action.parameters?.branch_contract
    return [
      `Objective: ${op.contract.objective}`,
      `Targets: ${op.contract.targets.join(', ') || '(derive from objective)'}`,
      `Action: ${action.name} (${action.id}), risk=${action.risk}`,
      focus ? `Coverage contract:\n- ${focus.join('\n- ')}` : '',
      'Produce tool-derived, reproducible evidence for this action only.',
    ].filter(Boolean).join('\n')
  }

  cancel(op, reason = 'user-requested') {
    op.status = 'cancelled'
    op.aborted = true
    op.updated_at = new Date().toISOString()
    saveOperation(op)
    appendEvent(op.run_id, 'operation/cancel', { reason })
    return op
  }

  events(runId, tail = 50) {
    return readEvents(runId, tail)
  }

  list(sessionKey, limit = 20) {
    return listOperations(sessionKey, limit)
  }
}
