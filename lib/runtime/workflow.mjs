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
