/**
 * SemanticJudge → StrictTerminalJudge — DSH-native port of runtime/terminal_judge.py.
 *
 * The original port's judge only checked that a handful of terminal predicates
 * were `verified`, so a broken evidence lineage, a final_report missing the
 * required artifact set, a goal-criterion mismatch, or an uncovered target
 * could all slip through as "completed". This restores the original structural
 * judgment:
 *  - multiple predicate kinds (workflow_actions_complete / artifact_verified /
 *    artifact_count / artifact_field) with 8 comparison operators
 *  - required_artifacts missing detection
 *  - evidence lineage (missing-parent + cycle, via DFS)
 *  - final_report coverage (must reach reproduction/impact/coverage/cleanup)
 *  - final_report ↔ GoalContract criterion matching
 *  - goal_targets_present / target_evidence coverage
 *  - (optional) required_action_evidence via action_status, when present
 *
 * The LLM route is kept as a semantic confidence booster on top of the strict
 * structural check, not as the primary gate.
 */

const HEURISTIC_MIN_LENGTH = {
  surface_map: 80,
  hypothesis_queue: 120,
  reproduction_artifact: 150,
  impact_proof: 120,
  coverage_report: 100,
  cleanup_proof: 60,
  final_report: 200,
}

const REPORT_REQUIRED_ARTIFACTS = ['reproduction_artifact', 'impact_proof', 'coverage_report', 'cleanup_proof']

export class SemanticJudge {
  constructor({ getRoute, getLlm } = {}) {
    this.getRoute = getRoute
    this.getLlm = getLlm
  }

  async callLlm(system, userText, { maxTokens = 400 } = {}) {
    const route = this.getRoute?.()
    const llm = this.getLlm?.()
    if (!route || !llm?.stream) return null
    try {
      const { createUserMessage, ReasoningEffortId } = await import('@deepseek-ai/dsh-llm')
      let text = ''
      const stream = llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: userText.slice(0, 6000) }] })],
        temperature: 0,
        reasoningEffort: ReasoningEffortId('off'),
        maxTokens,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
      }
      return text.trim() || null
    } catch {
      return null
    }
  }

  /** Artifact-level semantic verification (LLM + heuristic fallback). */
  async verifyArtifact(op, kind, contractObjective) {
    const nodes = op.evidence.filter((node) => node.kind === kind)
    if (nodes.length === 0) return { verified: false, method: 'heuristic', reason: `no evidence for ${kind}` }
    const combined = nodes.map((node) => (node.summary || '') + '\n' + (node.content ?? '')).join('\n---\n')
    const minLength = HEURISTIC_MIN_LENGTH[kind] ?? 80
    const verdict = await this.callLlm(
      'You are a strict red-team evidence verifier. Decide whether the EVIDENCE satisfies the ARTIFACT requirement for the objective. Reply with exactly one JSON object: {"verified": true|false, "reason": "<=30 words"}. No other text.',
      `OBJECTIVE: ${contractObjective}\nARTIFACT REQUIRED: ${kind}\n\nEVIDENCE:\n${combined}`,
      { maxTokens: 120 },
    )
    if (verdict) {
      try {
        const parsed = JSON.parse(verdict.replace(/^[^{]*/, '').replace(/[^}]*$/, ''))
        if (typeof parsed.verified === 'boolean') {
          return { verified: parsed.verified, method: 'llm', reason: String(parsed.reason ?? '') }
        }
      } catch {
        // Fall through to heuristic.
      }
    }
    const ok = combined.trim().length >= minLength && !/^(n\/a|none|todo)\b/i.test(combined.trim())
    return { verified: ok, method: 'heuristic', reason: ok ? 'length/content heuristic passed' : 'heuristic threshold not met' }
  }

  _compare(actual, operator, expected) {
    if (operator === 'exists') return actual !== undefined && actual !== null && actual !== false && actual !== '' && !(Array.isArray(actual) && actual.length === 0)
    if (operator === 'eq') return actual === expected
    if (operator === 'ne') return actual !== expected
    try {
      if (operator === 'gte') return actual >= expected
      if (operator === 'gt') return actual > expected
      if (operator === 'lte') return actual <= expected
      if (operator === 'lt') return actual < expected
    } catch {
      return false
    }
    if (operator === 'contains') {
      try { return actual && actual.includes(expected) } catch { return false }
    }
    return false
  }

  _evaluatePredicate(pred, op, spec, evidenceByType) {
    const byType = (t) => evidenceByType[t] ?? []
    switch (pred.kind) {
      case 'workflow_actions_complete': {
        const required = spec.actions.filter((a) => a.optional !== true)
        return required.every((a) => (op.completed_actions ?? []).includes(a.id))
      }
      case 'artifact_verified':
        return byType(pred.subject).length > 0
      case 'artifact_count':
        return this._compare(byType(pred.subject).length, pred.operator || 'exists', pred.value)
      case 'artifact_field': {
        const sep = pred.subject.indexOf('.')
        if (sep < 0) return false
        const artifactType = pred.subject.slice(0, sep)
        const fieldName = pred.subject.slice(sep + 1)
        return byType(artifactType).some((n) => this._compare(n.content?.[fieldName], pred.operator || 'exists', pred.value))
      }
      default:
        return false
    }
  }

  /** Evidence lineage check: missing parent OR cycle (DFS). */
  _lineageError(evidence) {
    const byId = new Map(evidence.map((n) => [n.id, n]))
    for (const node of evidence) {
      for (const parentId of node.parents ?? []) {
        if (!byId.has(parentId)) return 'evidence_lineage_missing_parent'
      }
    }
    const visiting = new Set()
    const visited = new Set()
    const visit = (id) => {
      if (visiting.has(id)) return false
      if (visited.has(id)) return true
      visiting.add(id)
      for (const parentId of byId.get(id)?.parents ?? []) {
        if (!visit(parentId)) return false
      }
      visiting.delete(id)
      visited.add(id)
      return true
    }
    for (const id of byId.keys()) {
      if (!visit(id)) return 'evidence_lineage_cycle'
    }
    return ''
  }

  /** Does any final_report reach all REPORT_REQUIRED_ARTIFACTS via parents? */
  _reportLineageComplete(finalReports, evidence) {
    const byId = new Map(evidence.map((n) => [n.id, n]))
    for (const report of finalReports) {
      const stack = [...(report.parents ?? [])]
      const visited = new Set()
      const found = new Set()
      while (stack.length) {
        const id = stack.pop()
        if (visited.has(id) || !byId.has(id)) continue
        visited.add(id)
        found.add(byId.get(id).kind)
        stack.push(...(byId.get(id).parents ?? []))
      }
      if (REPORT_REQUIRED_ARTIFACTS.every((t) => found.has(t))) return true
    }
    return false
  }

  /** Does any final_report's criteria exactly match goal.success_criteria with evidence? */
  _goalCriteriaComplete(finalReports, goal, evidence) {
    if (!goal?.success_criteria || goal.success_criteria.length === 0) return true
    const expected = new Map(goal.success_criteria.map((c) => [c.criterion_id, c]))
    const byId = new Map(evidence.filter((n) => n.verified).map((n) => [n.id, n]))
    for (const report of finalReports) {
      if (!report.content || typeof report.content !== 'object') continue
      const reported = new Map(
        (Array.isArray(report.content.criteria) ? report.content.criteria : [])
          .map((item) => [String(item.criterion_id || ''), item]),
      )
      if (reported.size !== expected.size || [...reported.keys()].some((k) => !expected.has(k))) continue
      let valid = true
      for (const [criterionId, criterion] of expected) {
        const item = reported.get(criterionId)
        const refs = (Array.isArray(item.evidence_refs) ? item.evidence_refs : []).map(String).filter((r) => byId.has(r))
        const nodes = refs.map((r) => byId.get(r))
        if (criterion.target && nodes.some((n) => n.target !== criterion.target)) { valid = false; break }
        if (item.status !== 'achieved' || !REPORT_REQUIRED_ARTIFACTS.every((t) => nodes.some((n) => n.kind === t))) { valid = false; break }
      }
      if (valid) return true
    }
    return false
  }

  /**
   * Terminal gate. Returns {terminal, success, unmet:[...], details:{kind:{verified,...}}}.
   * `op` carries evidence (each node now carries kind/parents/content_hash/target)
   * and optionally action_status (from the enhanced OperationState).
   */
  async judgeTerminal(op, spec, objective) {
    const unmet = []
    const details = {}
    const evidence = op.evidence ?? []

    // Build verified-by-kind map, plus raw node access for lineage/report checks.
    const evidenceByType = {}
    for (const node of evidence) {
      if (node.verified) (evidenceByType[node.kind] ||= []).push(node)
    }
    const verifiedNodes = (t) => evidenceByType[t] ?? []

    // 1) workflow_actions_complete + artifact predicates from terminal_predicates.
    for (const predicate of spec.terminal_predicates ?? []) {
      const pass = this._evaluatePredicate(predicate, op, spec, evidenceByType)
      details[`${predicate.kind}:${predicate.subject}`] = { verified: pass, method: 'structural' }
      if (!pass) unmet.push(predicate.subject || predicate.kind)
    }

    // 2) required_artifacts present.
    for (const artifactType of spec.required_artifacts ?? []) {
      if (verifiedNodes(artifactType).length === 0) unmet.push(`required_artifact:${artifactType}`)
    }

    // 3) final_report semantic + coverage checks (structural, no LLM required).
    const finalReports = verifiedNodes('final_report')
    if (finalReports.length > 0) {
      const achieved = finalReports.some((n) => n.content && n.content.goal_result === 'achieved')
      if (!achieved) unmet.push('final_report.goal_result:achieved')
      if (!this._reportLineageComplete(finalReports, evidence)) unmet.push('final_report_lineage_complete')
      if (!this._goalCriteriaComplete(finalReports, op.contract, evidence)) unmet.push('goal_criteria_complete')
    } else if ((spec.required_artifacts ?? []).includes('final_report')) {
      unmet.push('required_artifact:final_report')
    }

    // 4) action-lineage: completed action must have evidence of its expected artifact.
    if (op.action_status && typeof op.action_status === 'object') {
      for (const action of spec.actions ?? []) {
        if (action.optional) continue
        const nodes = (op.action_status[action.id] === 'completed' ? verifiedNodes(action.expected_artifact) : [])
        if (op.action_status[action.id] === 'completed' && nodes.length === 0) {
          unmet.push(`required_action_evidence:${action.id}`)
        }
      }
    }

    // 5) evidence lineage integrity.
    const lineageError = this._lineageError(evidence)
    if (lineageError) unmet.push(lineageError)

    // 6) goal targets coverage.
    const goalTargets = op.contract?.targets ?? []
    if (goalTargets.length === 0) {
      unmet.push('goal_targets_present')
    } else {
      const coveredTargets = new Set(evidence.filter((n) => n.verified && n.target).map((n) => n.target))
      for (const target of goalTargets) {
        if (!coveredTargets.has(target)) unmet.push(`target_evidence:${target}`)
      }
    }

    // 7) LLM/artifact semantic verify as a booster on top of structural gate.
    for (const artifactType of ['reproduction_artifact', 'impact_proof', 'cleanup_proof', 'final_report']) {
      const nodes = verifiedNodes(artifactType)
      if (nodes.length === 0) continue
      const result = await this.verifyArtifact(op, artifactType, objective)
      details[artifactType] = { verified: result.verified, method: result.method }
      if (!result.verified) {
        unmet.push(`${artifactType}:semantic`)
      }
    }

    const terminal = unmet.length === 0
    return {
      terminal,
      success: terminal && !op.aborted,
      unmet,
      details,
    }
  }
}
