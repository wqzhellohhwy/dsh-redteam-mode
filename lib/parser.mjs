/**
 * Mode command parser — faithful port of codex-redteam-mode hooks/core/prompt_parser.py.
 * Fullmatch semantics preserved: mode commands only trigger when the ENTIRE
 * message is the command (never mid-sentence).
 */

export const ENABLE_PATTERNS = [
  [/^\/redteam\s+full\b$/i, 'redteam-full'],
  [/^\/redteam\s+light\b$/i, 'redteam-light'],
  [/^\/redteam\s+on\b$/i, 'redteam-light'],
  [/^进入红队模式$/i, 'redteam-light'],
  [/^开启红队模式$/i, 'redteam-light'],
  [/^enable\s+red\s*team\s*mode$/i, 'redteam-light'],
]

export const DISABLE_PATTERNS = [
  /^退出红队模式$/i,
  /^关闭红队模式$/i,
  /^\/redteam\s+off\b$/i,
  /^disable\s+red\s*team\s*mode$/i,
]

export const OPSEC_PATTERNS = [
  [/^\/opsec\s+strict\b$/i, 'strict'],
  [/^\/opsec\s+balanced\b$/i, 'balanced'],
]

/** Returns the new mode ('redteam-full'|'redteam-light'|'normal') or null. */
export function parseModeCommand(prompt) {
  const candidate = String(prompt ?? '').trim()
  for (const [pattern, mode] of ENABLE_PATTERNS) {
    if (pattern.test(candidate)) return mode
  }
  for (const pattern of DISABLE_PATTERNS) {
    if (pattern.test(candidate)) return 'normal'
  }
  return null
}

/** Returns 'strict' | 'balanced' | null. */
export function parseOpsecCommand(prompt) {
  const candidate = String(prompt ?? '').trim()
  for (const [pattern, level] of OPSEC_PATTERNS) {
    if (pattern.test(candidate)) return level
  }
  return null
}
