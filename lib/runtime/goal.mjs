/**
 * Goal compiler — port of codex runtime/goal_compiler.py (+ security.redact_sensitive).
 * Extracts targets (URL/IP/host/path) with overlap dedup, builds the GoalContract.
 */
import { createHash } from 'node:crypto'
import { sha256 } from '../intent.mjs'
import { redactSensitive } from './security.mjs'

const URL_RE = /\bhttps?:\/\/[^\s<>'"]+/gi
const HOST_RE = /(?<![\w.-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|invalid|test)(?::\d{1,5})?(?![\w.-])/gi
const IP_RE = /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?![\d.])/g
/**
 * Path-like targets. The lookbehind also excludes CJK, because a bare `/`+
 * character inside ordinary Chinese prose — `(是/否)`, `和/或` — is not a path
 * and previously produced junk targets such as `/否`.
 */
const PATH_RE = /(?<![\w\u4e00-\u9fff])(?:[A-Za-z]:[\\/]|\.?\.?[\\/])[^\s<>'"，。；：！？）】]+/g

const TRIM_TAIL = /[.,;:!?)\]}，。；：！？）】]+$/

export function extractTargets(objective) {
  const text = String(objective ?? '')
  const discovered = []
  const patterns = [URL_RE, IP_RE, HOST_RE, PATH_RE]
  patterns.forEach((pattern, priority) => {
    pattern.lastIndex = 0
    for (const match of text.matchAll(pattern)) {
      const target = match[0].replace(TRIM_TAIL, '')
      if (target) discovered.push({ start: match.index, end: match.index + match[0].length, priority, target })
    }
  })
  discovered.sort((a, b) => a.start - b.start || a.priority - b.priority || (b.end - b.start) - (a.end - a.start))
  const candidates = []
  const occupied = []
  for (const item of discovered) {
    if (occupied.some(([s, e]) => item.start < e && item.end > s)) continue
    if (!candidates.includes(item.target)) {
      candidates.push(item.target)
      occupied.push([item.start, item.end])
    }
  }
  return candidates
}

export function extractContextTargets(context) {
  const candidates = []
  const targetKeys = new Set(['target', 'targets', 'url', 'uri', 'host', 'path', 'repository', 'repo', 'binary', 'sample'])
  const visit = (value, key = '') => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [k, v] of Object.entries(value)) visit(v, k.toLowerCase())
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key)
      return
    }
    if (typeof value !== 'string' || !value.trim()) return
    const cleaned = value.trim()
    let extracted = extractTargets(cleaned)
    if (targetKeys.has(key) && extracted.length === 0) extracted = [cleaned]
    for (const t of extracted) if (!candidates.includes(t)) candidates.push(t)
  }
  visit(context || {})
  return candidates
}

function successCriteria(objective, targets, workflowHints) {
  const criteria = []
  const resolvedTargets = targets.length > 0 ? targets : ['']
  for (const target of resolvedTargets) {
    for (const workflowId of workflowHints) {
      const identity = `${objective}\u0000${target}\u0000${workflowId}`
      const criterionId = `criterion-${createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 16)}`
      const scope = target ? ` for ${target}` : ''
      criteria.push({
        criterion_id: criterionId,
        statement: `Complete the ${workflowId} evidence path${scope}: ${objective}`,
        target,
        workflow_id: workflowId,
      })
    }
  }
  return criteria
}

/** Compile objective → GoalContract. */
export function compileGoal(objective, { targets, startingContext, constraints, maxActions = 64, maxRetriesPerAction = 2 } = {}) {
  const cleaned = String(objective ?? '').trim()
  if (!cleaned) throw new Error('objective_required')
  const resolvedTargets =
    targets && targets.length > 0 ? targets : extractTargets(cleaned).length > 0 ? extractTargets(cleaned) : extractContextTargets(startingContext)
  const redactedObjective = redactSensitive(cleaned)
  const redactedTargets = resolvedTargets.map(redactSensitive)
  const hints = ['generic-adaptive']
  const createdAt = new Date().toISOString()
  return {
    contract_id: `contract-${sha256(`${redactedObjective}\u0000${createdAt}`).slice(0, 16)}`,
    created_at: createdAt,
    objective: redactedObjective,
    targets: redactedTargets,
    workflow_hint: hints[0],
    workflow_hints: hints,
    starting_context: redactSensitive(cloneDeep(startingContext ?? {})),
    constraints: redactSensitive(cloneDeep(constraints ?? {})),
    success_criteria: successCriteria(redactedObjective, redactedTargets, hints),
    stop_conditions: ['action_budget_exhausted', 'explicit_stop_condition', 'nonrecoverable_tool_failure'],
    max_actions: maxActions,
    max_retries_per_action: maxRetriesPerAction,
  }
}

/** Structured-deep clone for plain JSON data (no functions, no prototypes). */
function cloneDeep(value, seen = new Map()) {
  if (value === null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const copy = []
    seen.set(value, copy)
    for (const item of value) copy.push(cloneDeep(item, seen))
    return copy
  }
  const copy = {}
  seen.set(value, copy)
  for (const [k, v] of Object.entries(value)) copy[k] = cloneDeep(v, seen)
  return copy
}
