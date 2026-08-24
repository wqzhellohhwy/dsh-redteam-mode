/**
 * Semantic verifier + terminal judge — DSH-native upgrade of runtime/verifier.py
 * and runtime/terminal_judge.py. Where the Codex runtime used heuristic checks
 * only, this judge calls the routed LLM (ctx.llm) to semantically verify each
 * required artifact against the GoalContract, and degrades to heuristics when
 * no LLM route is available.
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

export class SemanticJudge {
  constructor({ getRoute, getLlm } = {}) {
    this.getRoute = getRoute // () => {provider, model} | null — read live per call
    this.getLlm = getLlm // () => llm service or undefined (opportunistic resolve)
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

  /**
   * Verify one artifact kind. Returns {verified, method:'llm'|'heuristic',
   * reason}.
   */
  async verifyArtifact(op, kind, contractObjective) {
    const nodes = op.evidence.filter((node) => node.kind === kind)
    if (nodes.length === 0) return { verified: false, method: 'heuristic', reason: `no evidence for ${kind}` }
    const combined = nodes.map((node) => node.summary + '\n' + (node.content ?? '')).join('\n---\n')
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

  /**
   * Evaluate every terminal predicate of the workflow spec.
   * Returns {terminal, success, unmet:[...], details:{kind:...}}.
   */
  async judgeTerminal(op, spec, objective) {
    const unmet = []
    const details = {}
    for (const predicate of spec.terminal_predicates) {
      if (predicate.kind === 'workflow_actions_complete') {
        const required = spec.actions.filter((action) => action.risk !== undefined)
        const allDone = required.every((action) => op.completed_actions.includes(action.id))
        details.workflow_actions_complete = allDone
        if (!allDone) unmet.push('workflow_actions_complete')
        continue
      }
      if (predicate.kind === 'artifact_verified') {
        const artifact = op.artifacts[predicate.subject]
        let verified = artifact?.verified === true
        if (!verified && (artifact?.evidence_ids?.length ?? 0) > 0) {
          const result = await this.verifyArtifact(op, predicate.subject, objective)
          details[predicate.subject] = result
          verified = result.verified
          if (verified) {
            const { markVerified } = await import('./evidence.mjs')
            markVerified(op, predicate.subject, `${result.method}:${result.reason.slice(0, 80)}`)
          }
        } else {
          details[predicate.subject] = { verified, method: 'recorded' }
        }
        if (!verified) unmet.push(predicate.subject)
      }
    }
    return {
      terminal: unmet.length === 0,
      success: unmet.length === 0 && !op.aborted,
      unmet,
      details,
    }
  }
}
