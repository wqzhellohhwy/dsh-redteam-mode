/**
 * generic-adaptive workflow — typed embedding of codex workflows/generic-adaptive.toml (v2).
 * Embedded as data instead of parsing TOML at runtime (zero-dependency choice).
 */

export const GENERIC_ADAPTIVE = {
  workflow: {
    id: 'generic-adaptive',
    version: 2,
    name: 'Unified adaptive red-team operation',
    description:
      'One evidence-driven control flow for web, source, binary, identity, cloud, model, CTF, IR, and adversary-emulation goals.',
    match_tags: ['adaptive', 'redteam', 'assessment', 'test', 'analyze', '评估', '测试', '分析'],
    required_artifacts: [
      'surface_map',
      'hypothesis_queue',
      'reproduction_artifact',
      'impact_proof',
      'coverage_report',
      'cleanup_proof',
      'final_report',
    ],
  },
  actions: [
    {
      id: 'map-surface',
      name: 'Map the initial surface',
      capabilities: ['target_intake', 'environment_inventory', 'page_fetch', 'code_analysis', 'binary_reverse', 'identity_inventory', 'model_probe'],
      expected_artifact: 'surface_map',
      verifier: 'surface_map',
      depends_on: [],
      risk: 'passive',
      tool_strategy: 'capability_coverage',
      min_tool_results: 1,
      max_tool_results: 4,
      parameters: {
        coverage_focus: [
          'asset and target provenance',
          'entrypoints and exposed services',
          'identities, permissions, and trust edges',
          'data and control flow',
          'runtime, deployment, and protection state',
          'telemetry and rollback prerequisites',
        ],
      },
    },
    {
      id: 'build-hypotheses',
      name: 'Build evidence-linked hypotheses',
      capabilities: ['reasoning', 'code_generation'],
      expected_artifact: 'hypothesis_queue',
      verifier: 'hypothesis_queue',
      depends_on: ['map-surface'],
      risk: 'safe',
      parameters: {
        prioritization: ['evidence strength', 'end-to-end reachability', 'goal-relevant impact', 'tool readiness', 'cost and noise', 'reversibility'],
        branch_contract: ['prove one end-to-end path before breadth', 'bind each hypothesis to parent evidence', 'keep explicit prerequisites and falsifiers'],
      },
    },
    {
      id: 'validate-path',
      name: 'Validate the highest-value path',
      capabilities: ['controlled_validation', 'browser_automation', 'test_harness', 'binary_reverse', 'identity_validation', 'prompt_evaluation', 'technique_execution', 'code_generation'],
      expected_artifact: 'reproduction_artifact',
      verifier: 'reproduction_artifact',
      depends_on: ['build-hypotheses'],
      risk: 'active_medium',
      parameters: {
        validation_contract: [
          'establish a measured baseline',
          'validate prerequisites',
          'test one hypothesis with the lowest-noise proving action',
          'capture raw reproducible evidence',
          'run a matched negative control',
          'record side effects and rollback',
        ],
      },
    },
    {
      id: 'prove-impact',
      name: 'Prove goal-relevant impact',
      capabilities: ['impact_analysis', 'reasoning'],
      expected_artifact: 'impact_proof',
      verifier: 'impact_proof',
      depends_on: ['validate-path'],
      risk: 'active_low',
    },
    {
      id: 'review-coverage',
      name: 'Review coverage and false positives',
      capabilities: ['coverage_analysis', 'reasoning'],
      expected_artifact: 'coverage_report',
      verifier: 'coverage_report',
      depends_on: ['prove-impact'],
      risk: 'safe',
    },
    {
      id: 'cleanup',
      name: 'Execute and verify rollback',
      capabilities: ['cleanup', 'rollback'],
      expected_artifact: 'cleanup_proof',
      verifier: 'cleanup_proof',
      depends_on: ['review-coverage'],
      risk: 'active_low',
    },
    {
      id: 'report',
      name: 'Build the final evidence report',
      capabilities: ['report_generation', 'reasoning'],
      expected_artifact: 'final_report',
      verifier: 'final_report',
      depends_on: ['cleanup'],
      risk: 'safe',
    },
  ],
  terminal_predicates: [
    { kind: 'workflow_actions_complete', subject: 'required' },
    { kind: 'artifact_verified', subject: 'reproduction_artifact' },
    { kind: 'artifact_verified', subject: 'impact_proof' },
    { kind: 'artifact_verified', subject: 'cleanup_proof' },
    { kind: 'artifact_verified', subject: 'final_report' },
  ],
}

/** Actions whose dependencies are all satisfied. */
export function readyActions(spec, completedIds) {
  const done = new Set(completedIds)
  return spec.actions.filter((action) => action.depends_on.every((dep) => done.has(dep)) && !done.has(action.id))
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Normalise a spec: return {workflowMeta, actions, terminalPredicates, requiredArtifacts}. */
function normalizeSpec(spec) {
  const meta = spec.workflow ?? spec
  const actions = spec.actions ?? spec.workflow?.actions ?? []
  const predicates = spec.terminal_predicates ?? spec.workflow?.terminal_predicates ?? []
  const required = spec.required_artifacts ?? spec.workflow?.required_artifacts ?? []
  return { meta, actions, predicates, required }
}

/**
 * Validate a workflow spec, mirroring workflow_registry._validate. Throws on:
 *  - invalid workflow id, missing actions, empty id/artifact/capabilities
 *  - non-identifier action ids, duplicate ids
 *  - unknown dependency, dependency cycle
 * Running this at load time surfaces config errors instead of silently failing.
 */
export function validateWorkflow(spec) {
  const { meta, actions, predicates, required } = normalizeSpec(spec)
  const id = String(meta.id || meta.workflow_id || '')
  if (id !== 'generic-adaptive') throw new Error(`workflow_id_invalid:${id || '<none>'}`)
  if (!Array.isArray(actions) || actions.length === 0) throw new Error('workflow_actions_missing:generic-adaptive')
  const ids = actions.map((a) => a.id)
  if (ids.some((a) => !IDENTIFIER_RE.test(String(a ?? '')))) throw new Error('workflow_action_id_invalid:generic-adaptive')
  if (new Set(ids).size !== ids.length) throw new Error('workflow_duplicate_action:generic-adaptive')
  const known = new Set(ids)
  for (const action of actions) {
    if (!Array.isArray(action.capabilities) || action.capabilities.length === 0 || !action.expected_artifact) {
      throw new Error(`workflow_action_incomplete:${action.id}`)
    }
    const unknown = (action.depends_on ?? []).filter((d) => !known.has(d))
    if (unknown.length > 0) throw new Error(`workflow_unknown_dependency:${action.id}:${[...unknown].sort().join(',')}`)
  }
  // Dependency cycle (Kahn's algorithm).
  const deps = new Map(actions.map((a) => [a.id, new Set(a.depends_on ?? [])]))
  let remaining = new Set(ids)
  while (remaining.size > 0) {
    const ready = [...remaining].filter((x) => ![...deps.get(x)].some((d) => remaining.has(d)))
    if (ready.length === 0) throw new Error('workflow_dependency_cycle:generic-adaptive')
    ready.forEach((x) => remaining.delete(x))
  }
  return { workflow_id: id, actions, terminal_predicates: predicates, required_artifacts: required }
}

/** Return the validated generic-adaptive workflow (throwing on config error). */
export function getWorkflow() {
  return validateWorkflow(GENERIC_ADAPTIVE)
}
