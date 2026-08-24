/**
 * Evidence graph — condensed port of runtime/evidence_graph.py.
 * Nodes carry artifact type, provenance (parent evidence ids), raw payload
 * references, and verification state. Stored inside the operation JSON.
 */

export function newEvidenceNode({ id, kind, actionId, parents = [], summary, content, meta }) {
  return {
    id: id || `ev-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    action_id: actionId || '',
    parents,
    summary: String(summary ?? '').slice(0, 400),
    content,
    meta: meta ?? {},
    verified: false,
    created_at: new Date().toISOString(),
  }
}

export function addEvidence(op, node) {
  op.evidence.push(node)
  if (!op.artifacts[node.kind]) op.artifacts[node.kind] = { evidence_ids: [], verified: false }
  const artifact = op.artifacts[node.kind]
  if (!artifact.evidence_ids.includes(node.id)) artifact.evidence_ids.push(node.id)
  return node
}

/** All ancestor ids of a node (transitive closure over parent links). */
export function lineage(op, nodeId) {
  const byId = new Map(op.evidence.map((node) => [node.id, node]))
  const seen = new Set()
  const stack = [...(byId.get(nodeId)?.parents ?? [])]
  while (stack.length > 0) {
    const current = stack.pop()
    if (seen.has(current)) continue
    seen.add(current)
    const parent = byId.get(current)
    if (parent) stack.push(...parent.parents)
  }
  return [...seen]
}

export function markVerified(op, kind, verifiedBy) {
  for (const node of op.evidence) {
    if (node.kind === kind) node.verified = true
  }
  if (op.artifacts[kind]) {
    op.artifacts[kind].verified = true
    op.artifacts[kind].verified_by = verifiedBy
    op.artifacts[kind].verified_at = new Date().toISOString()
  }
}

export function summarizeGraph(op) {
  const kinds = {}
  for (const node of op.evidence) {
    kinds[node.kind] = kinds[node.kind] || { count: 0, verified: 0 }
    kinds[node.kind].count += 1
    if (node.verified) kinds[node.kind].verified += 1
  }
  return { total_nodes: op.evidence.length, by_kind: kinds }
}
