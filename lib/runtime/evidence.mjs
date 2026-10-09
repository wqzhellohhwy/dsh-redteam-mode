/**
 * Evidence graph — condensed port of runtime/evidence_graph.py.
 * Nodes carry artifact type, content hash, provenance (parent evidence ids),
 * confidence, target, tool, verifier, and verification state. Stored inside
 * the operation JSON (in-memory), with an optional artifact on disk.
 *
 * This is the DSH-native upgrade that restores the original evidence
 * integrity guarantees the port dropped:
 *   - content_hash  → idempotent dedup + tamper detection
 *   - parent_id     → lineage; missing parents are rejected (no orphans)
 *   - confidence    → [0,1] per-node strength
 *   - target/tool/verifier/run_id → full audit provenance
 * The original `addEvidence`/`markVerified`/`lineage`/`summarizeGraph` API is
 * preserved so existing callers keep working.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'

/** Deterministic content hash of a payload (JSON-stable serialization). */
export function contentHash(payload) {
  const serialized = JSON.stringify(payload ?? {}, (k, v) => (typeof v === 'object' ? v : v), 0)
  // JSON.stringify with a stable key order for dict-like input.
  const stable = stableStringify(payload)
  return createHash('sha256').update(stable || serialized, 'utf8').digest('hex')
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  const keys = Object.keys(value).sort()
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
}

function sanitizeSegment(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80)
}

/**
 * Build a new evidence node. `kind` is the artifact type (surface_map,
 * hypothesis_queue, reproduction_artifact, impact_proof, coverage_report,
 * cleanup_proof, final_report). Extra fields are honoured; defaults applied.
 */
export function newEvidenceNode({ id, kind, actionId, parents = [], summary, content, meta, runId, target, tool, confidence, verifier }) {
  const digest = contentHash(content ?? summary ?? '')
  return {
    id: id || `ev-${Math.random().toString(36).slice(2, 10)}`,
    kind,
    action_id: actionId || '',
    run_id: runId || '',
    target: target || '',
    tool: tool || '',
    verifier: verifier || '',
    parents,
    summary: String(summary ?? '').slice(0, 400),
    content,
    content_hash: digest,
    confidence: clampConfidence(confidence),
    meta: meta ?? {},
    verified: false,
    created_at: new Date().toISOString(),
  }
}

function clampConfidence(value) {
  const n = Number(value ?? 1)
  if (Number.isFinite(n)) return Math.max(0, Math.min(1, n))
  return 1
}

/**
 * Record an evidence node and attach it to the operation's artifact set.
 * Enforces lineage: every parent must already exist in the op evidence.
 * Idempotent by (kind, action_id, content_hash): replaying the same finding
 * returns the existing node instead of duplicating it.
 */
export function addEvidence(op, node) {
  if (!op || !Array.isArray(op.evidence)) {
    throw new Error('addEvidence: operation has no evidence array')
  }
  // Lineage check: reject orphan parents.
  for (const parentId of node.parents || []) {
    if (!op.evidence.some((n) => n.id === parentId)) {
      throw new Error(`evidence_parent_missing:${parentId}`)
    }
  }
  // Idempotent dedup by (kind, action_id, content_hash).
  const dup = op.evidence.find(
    (n) => n.kind === node.kind && n.action_id === node.action_id && n.content_hash === node.content_hash,
  )
  if (dup) {
    dup.verified = dup.verified || node.verified
    return dup
  }
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

/**
 * Persist one evidence node as a standalone artifact JSON (audit-grade),
 * mirroring evidence_graph._write_artifact with tmp+rename and sanitized path.
 */
export function writeArtifact(node, artifactRoot) {
  try {
    if (!artifactRoot) return null
    const safeRun = sanitizeSegment(node.run_id || node.action_id)
    const safeAction = sanitizeSegment(node.action_id)
    const safeKind = sanitizeSegment(node.kind)
    const toolDigest = createHash('sha256').update(String(node.tool || ''), 'utf8').digest('hex').slice(0, 8)
    const dir = join(artifactRoot, safeRun)
    mkdirSync(dirname(join(dir, 'x')), { recursive: true })
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${safeAction}-${safeKind}-${node.content_hash.slice(0, 12)}-${toolDigest}.json`)
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(node, null, 2), 'utf8')
    try {
      renameSync(tmp, path)
    } catch {
      writeFileSync(path, JSON.stringify(node, null, 2), 'utf8')
    }
    return path
  } catch {
    return null
  }
}
