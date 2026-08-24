/**
 * Model prompt profiles — port of codex hooks/core/model_prompt_profiles.py.
 * Routes the active model to a per-family supplemental profile file under
 * resources/prompts/. The mapping is data: add an entry for a new model
 * family without touching code. DSH improvement: the model is captured live
 * from the llm/stream route (per session) instead of a static config field,
 * so mid-session model switches re-route automatically.
 */
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const RESOURCES_DIR = join(HERE, '..', 'resources')
export const PROMPTS_DIR = join(RESOURCES_DIR, 'prompts')

export const DEFAULT_PROFILE_FILES = {
  'gpt-5.6*': 'Jailbreak.gpt-5.6.md',
  'gpt-5.5*': 'Jailbreak.gpt-5.5.md',
  'gpt-5.4*': 'Jailbreak.gpt-5.4.md',
  default: 'Jailbreak.default.md',
}

/** fnmatch-style match: glob chars honored; plain prefix falls back to startsWith. */
function matchesPattern(model, pattern) {
  const normalized = String(model).toLowerCase()
  const lowered = pattern.toLowerCase()
  if (!/[*?[]/.test(lowered)) return normalized.startsWith(lowered)
  const regex = new RegExp(
    '^' + lowered.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$',
  )
  return regex.test(normalized)
}

export function resolveProfileFile(model, mapping = DEFAULT_PROFILE_FILES) {
  const patterns = Object.keys(mapping)
    .filter((key) => key !== 'default')
    .sort((a, b) => b.length - a.length)
  for (const pattern of patterns) {
    if (matchesPattern(model, pattern)) return { profile: pattern, filename: mapping[pattern] }
  }
  return { profile: 'default', filename: mapping.default }
}

/** Load the supplemental profile content; degrade to default, then ''. */
export function loadProfileContent(model, mapping = DEFAULT_PROFILE_FILES) {
  let resolved = resolveProfileFile(model, mapping)
  let path = join(PROMPTS_DIR, resolved.filename)
  if (!existsSync(path)) {
    resolved = { profile: 'default', filename: resolveProfileFile('unknown', mapping).filename }
    path = join(PROMPTS_DIR, resolved.filename)
  }
  if (!existsSync(path)) return { ...resolved, content: '' }
  try {
    return { ...resolved, content: readFileSync(path, 'utf8').trim() }
  } catch {
    return { ...resolved, content: '' }
  }
}

/** Load the base mode contract (instruction.ctf.md). */
export function loadModeContract() {
  const path = join(RESOURCES_DIR, 'instruction.ctf.md')
  if (!existsSync(path)) return ''
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}
