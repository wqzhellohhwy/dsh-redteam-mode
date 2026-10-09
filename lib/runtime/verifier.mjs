/**
 * SemanticVerifier — DSH-native port of runtime/verifier.py.
 *
 * The port dropped the original structural verification entirely, so a
 * malformed artifact (missing negative_controls, missing side_effects, a
 * final_report without criteria, etc.) could be marked complete. This module
 * restores it: per-artifact OUTPUT_CONTRACTS schemas, derive-artifact parent
 * constraints, and exact final_report ↔ GoalContract criterion matching.
 *
 * It returns a VerificationDecision {passed, payload, confidence, reason,
 * parent_ids}. Pure — it does not touch the operation; the caller wires it in.
 */
import { redactSensitive } from './security.mjs'

export const MAX_EVIDENCE_BYTES = 4 * 1024 * 1024

/** Artifacts that must reference already-verified parent evidence. */
export const DERIVED_ARTIFACTS = new Set([
  'hypothesis_queue',
  'reproduction_artifact',
  'impact_proof',
  'coverage_report',
  'cleanup_proof',
  'final_report',
])

export const OUTPUT_CONTRACTS = {
  surface_map: { any_of: ['targets', 'assets', 'hosts', 'routes', 'services', 'files', 'components', 'results'] },
  hypothesis_queue: {
    required: ['evidence_refs', 'hypotheses'],
    hypotheses: 'non-empty array of {id, statement, priority, evidence_refs, negative_control}',
  },
  reproduction_artifact: {
    required: ['reproducible', 'evidence_refs', 'negative_controls', 'side_effects'],
    reproducible: true,
    any_of: ['request_response', 'commands', 'tests', 'observations', 'results', 'transcript'],
  },
  impact_proof: {
    required: ['evidence_refs'],
    one_of: [{ verified: true }, { measured: true }],
    any_of: ['impact', 'outcomes', 'before_after', 'observations', 'results', 'metrics'],
  },
  coverage_report: {
    required: ['evidence_refs'],
    any_of: ['checked', 'coverage', 'matrix', 'metrics'],
    control_any_of: ['negative_controls', 'false_positive_controls', 'excluded'],
  },
  cleanup_proof: {
    required: ['evidence_refs', 'verified', 'outstanding_changes'],
    verified: true,
    outstanding_changes: [],
    any_of: ['actions', 'rollback', 'results', 'checks'],
  },
  final_report: {
    required: ['evidence_refs', 'goal_result', 'criteria'],
    goal_result: ['achieved', 'not_achieved', 'partial'],
    criteria: 'exact GoalContract criteria with status and evidence_refs',
    any_of: ['report', 'findings', 'summary'],
  },
}

const fallbackContract = () => ({ any_of: ['results', 'output', 'findings', 'observations'] })

export function getOutputContract(verifier) {
  return { ...(OUTPUT_CONTRACTS[verifier] ?? fallbackContract()) }
}

function nonempty(payload, keys) {
  for (const key of keys) {
    const value = payload[key]
    if (typeof value === 'string' || Array.isArray(value) || (typeof value === 'object' && value)) {
      if (Array.isArray(value) && value.length === 0) continue
      if (typeof value === 'string' && value.trim().length === 0) continue
      if (typeof value === 'object' && Object.keys(value).length === 0) continue
      return true
    }
    if (value !== undefined && value !== null && value !== false && value !== '' && value !== 0) return true
  }
  return false
}

function evidenceRefs(payload) {
  const raw = payload.evidence_refs
  if (!Array.isArray(raw)) return []
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))]
}

/** Validate one artifact payload against its output contract. */
function validateSchema(verifier, payload) {
  switch (verifier) {
    case 'surface_map':
      return nonempty(payload, ['targets', 'assets', 'hosts', 'addresses', 'routes', 'services', 'files', 'components', 'surface', 'results', 'output'])
        ? [true, 'surface_verified']
        : [false, 'surface_evidence_missing']

    case 'hypothesis_queue': {
      const hypotheses = payload.hypotheses
      const valid = Array.isArray(hypotheses) && hypotheses.length > 0 && hypotheses.every((item) => (
        item && typeof item === 'object' &&
        Boolean(item.id) && Boolean(item.statement) &&
        ['critical', 'high', 'medium', 'low'].includes(item.priority) &&
        Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0 &&
        Boolean(item.negative_control)
      ))
      return valid ? [true, 'hypotheses_verified'] : [false, 'hypotheses_missing']
    }

    case 'reproduction_artifact': {
      const reproducible = payload.reproducible === true
      const concrete = nonempty(payload, ['request_response', 'commands', 'tests', 'observations', 'results', 'transcript'])
      const controls = nonempty(payload, ['negative_controls', 'false_positive_controls'])
      const sideEffectsDeclared = 'side_effects' in payload
      return reproducible && concrete && controls && sideEffectsDeclared
        ? [true, 'reproduction_verified']
        : [false, 'reproduction_requires_concrete_replay']
    }

    case 'impact_proof': {
      const measured = payload.verified === true || payload.measured === true
      const concrete = nonempty(payload, ['impact', 'outcomes', 'before_after', 'observations', 'results', 'metrics'])
      return measured && concrete ? [true, 'impact_verified'] : [false, 'impact_requires_measured_outcome']
    }

    case 'coverage_report': {
      const checked = nonempty(payload, ['checked', 'coverage', 'matrix', 'metrics'])
      const controls = nonempty(payload, ['negative_controls', 'false_positive_controls', 'excluded'])
      return checked && controls ? [true, 'coverage_verified'] : [false, 'coverage_requires_checks_and_negative_controls']
    }

    case 'cleanup_proof': {
      const actions = nonempty(payload, ['actions', 'rollback', 'results', 'checks'])
      const verified = payload.verified === true && !payload.outstanding_changes
      return actions && verified ? [true, 'cleanup_verified'] : [false, 'cleanup_requires_verified_rollback']
    }

    case 'final_report': {
      const report = nonempty(payload, ['report', 'findings', 'summary'])
      const goalResult = ['achieved', 'not_achieved', 'partial'].includes(payload.goal_result)
      const criteria = payload.criteria
      const criteriaValid = Array.isArray(criteria) && criteria.length > 0 && criteria.every((item) => (
        item && typeof item === 'object' &&
        Boolean(item.criterion_id) &&
        ['achieved', 'not_achieved'].includes(item.status) &&
        Array.isArray(item.evidence_refs) && item.evidence_refs.length > 0
      ))
      return report && goalResult && criteriaValid
        ? [true, 'report_verified']
        : [false, 'report_requires_goal_criteria_and_findings']
    }

    default:
      return nonempty(payload, ['results', 'output', 'findings', 'observations'])
        ? [true, 'generic_verified']
        : [false, 'generic_evidence_missing']
  }
}

/**
 * Verify an action's tool result against the artifact contract.
 * Returns {passed, payload, confidence, reason, parent_ids}.
 * `goal` is the GoalContract (for target + success_criteria matching);
 * `availableEvidence` is the op's current evidence list.
 */
export function verifyArtifact({ verifier, result, goal, availableEvidence }) {
  if (!result || result.status !== 'success' || result.isError) {
    return { passed: false, payload: {}, confidence: 0, reason: result?.error || 'tool_call_failed', parent_ids: [] }
  }
  const payload = normalizeOutput(result.output)
  if (!payload || Object.keys(payload).length === 0) {
    return { passed: false, payload: {}, confidence: 0, reason: 'empty_tool_output', parent_ids: [] }
  }
  const serializedSize = Buffer.byteLength(JSON.stringify(payload), 'utf8')
  if (serializedSize > MAX_EVIDENCE_BYTES) {
    return { passed: false, payload: {}, confidence: 0, reason: 'evidence_payload_too_large', parent_ids: [] }
  }

  const declaredArtifact = String(payload.artifact_type || payload.kind || '')
  if (declaredArtifact && declaredArtifact !== verifier) {
    return { passed: false, payload, confidence: 0, reason: 'artifact_type_mismatch', parent_ids: [] }
  }
  const declaredTarget = String(payload.target || '')
  const goalTargets = goal?.targets || []
  if (declaredTarget && goalTargets.length > 0 && !goalTargets.includes(declaredTarget)) {
    return { passed: false, payload, confidence: 0, reason: 'evidence_target_mismatch', parent_ids: [] }
  }

  let confidence = Number(payload.confidence ?? 1)
  if (!Number.isFinite(confidence)) return { passed: false, payload, confidence: 0, reason: 'invalid_confidence', parent_ids: [] }
  confidence = Math.max(0, Math.min(1, confidence))
  if (confidence < 0.7) {
    return { passed: false, payload, confidence, reason: 'confidence_below_threshold', parent_ids: [] }
  }

  const [passed, reason] = validateSchema(verifier, payload)
  if (!passed) return { passed: false, payload, confidence, reason, parent_ids: [] }

  const parentIds = evidenceRefs(payload)
  const byId = new Map((availableEvidence || []).map((n) => [n.id, n]))
  if (DERIVED_ARTIFACTS.has(verifier)) {
    if (parentIds.length === 0) return { passed: false, payload, confidence, reason: 'derived_evidence_requires_parents', parent_ids: [] }
    if (!parentIds.every((id) => byId.has(id))) return { passed: false, payload, confidence, reason: 'unknown_evidence_reference', parent_ids: [] }
    if (parentIds.some((id) => byId.get(id) && byId.get(id).verified !== true)) {
      return { passed: false, payload, confidence, reason: 'unverified_evidence_reference', parent_ids: [] }
    }
  }

  if (verifier === 'final_report' && goal?.success_criteria && goal.success_criteria.length > 0) {
    const expected = new Map(goal.success_criteria.map((c) => [c.criterion_id, c]))
    const reported = new Map(
      (Array.isArray(payload.criteria) ? payload.criteria : [])
        .filter((item) => item && typeof item === 'object')
        .map((item) => [String(item.criterion_id || ''), item]),
    )
    if (reported.size !== expected.size || [...reported.keys()].some((k) => !expected.has(k))) {
      return { passed: false, payload, confidence, reason: 'goal_criteria_mismatch', parent_ids: [] }
    }
    for (const [criterionId, criterion] of expected) {
      const item = reported.get(criterionId)
      const refs = Array.isArray(item.evidence_refs) ? item.evidence_refs.map(String) : []
      if (refs.length === 0 || refs.some((r) => !byId.has(r))) {
        return { passed: false, payload, confidence, reason: 'goal_criterion_evidence_invalid', parent_ids: [] }
      }
      const scoped = refs.map((r) => byId.get(r))
      if (criterion.target && scoped.some((n) => n.target !== criterion.target)) {
        return { passed: false, payload, confidence, reason: 'goal_criterion_target_mismatch', parent_ids: [] }
      }
      const required = ['reproduction_artifact', 'impact_proof', 'coverage_report', 'cleanup_proof']
      const scopedTypes = new Set(scoped.map((n) => n.kind))
      const achieved = item.status === 'achieved'
      if (achieved !== required.every((t) => scopedTypes.has(t))) {
        return { passed: false, payload, confidence, reason: 'goal_criterion_status_unproven', parent_ids: [] }
      }
    }
    if (payload.goal_result === 'achieved' && [...reported.values()].some((item) => item.status !== 'achieved')) {
      return { passed: false, payload, confidence, reason: 'goal_result_exceeds_criteria', parent_ids: [] }
    }
  }

  return { passed: true, payload, confidence, reason, parent_ids: parentIds }
}

/** Normalize tool output into a redacted mapping, mirroring verifier.normalize_output. */
export function normalizeOutput(output) {
  if (output && typeof output === 'object' && !Array.isArray(output)) {
    if (output.structuredContent && typeof output.structuredContent === 'object') {
      return redactSensitive({ ...output.structuredContent })
    }
    if (output.artifact && typeof output.artifact === 'object') {
      return redactSensitive({ ...output.artifact })
    }
    if (Array.isArray(output.content)) {
      const texts = output.content
        .filter((b) => b && typeof b === 'object' && b.type === 'text')
        .map((b) => String(b.text))
        .join('\n')
        .trim()
      if (texts) {
        try {
          const decoded = JSON.parse(texts)
          if (decoded && typeof decoded === 'object') return redactSensitive({ ...decoded })
          return redactSensitive({ output: decoded, raw_mcp: { ...output } })
        } catch {
          return redactSensitive({ output: texts, raw_mcp: { ...output } })
        }
      }
    }
    return redactSensitive({ ...output })
  }
  if (typeof output === 'string') {
    const stripped = output.trim()
    if (!stripped) return {}
    try {
      const decoded = JSON.parse(stripped)
      if (decoded && typeof decoded === 'object') return redactSensitive({ ...decoded })
      return redactSensitive({ output: decoded })
    } catch {
      return redactSensitive({ output: stripped })
    }
  }
  if (output === undefined || output === null) return {}
  return redactSensitive({ output })
}
