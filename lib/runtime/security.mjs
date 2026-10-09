/**
 * Security helpers — port of runtime/security.py.
 * Upgrades the port's string-only `redactSensitive` to object-level recursive
 * redaction with sensitive KEY detection and sha256 fingerprint placeholders.
 *
 * The port only masked objective/targets strings and skipped starting_context
 * / constraints entirely, which leaks nested secrets (e.g. {
 * headers:{ authorization: ... } }). This restores key-aware recursive
 * redaction and directory/file permission hardening (0700/0600 on POSIX).
 */
import { createHash } from 'node:crypto'
import { mkdirSync, chmodSync, existsSync } from 'node:fs'

const SENSITIVE_KEY_RE =
  /(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|cookie|session[_-]?token)/i

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|session[_-]?token)(\s*[:=]\s*)["']?[^\s"',;&]+/gi,
]

function redactedDigest(value) {
  if (typeof value === 'string' && value.startsWith('[REDACTED')) return value
  const digest = createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 12)
  return `[REDACTED sha256:${digest}]`
}

function isSensitiveKey(key) {
  return typeof key === 'string' && SENSITIVE_KEY_RE.test(key)
}

/**
 * Recursively redact a value. When `key` is a sensitive name, replace the
 * whole value with a digest placeholder; otherwise redact embedded secret
 * patterns in strings and recurse into objects/arrays.
 */
export function redactSensitive(value, key = '') {
  if (key && isSensitiveKey(key)) return redactedDigest(value)
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[String(k)] = redactSensitive(v, String(k))
    return out
  }
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item))
  if (typeof value === 'string') {
    let out = value
    for (const pattern of SECRET_VALUE_PATTERNS) {
      if (pattern.groups >= 2) {
        out = out.replace(pattern, (match, g1, g2) => `${g1}${g2}[REDACTED]`)
      } else {
        out = out.replace(pattern, '[REDACTED]')
      }
    }
    return out
  }
  return value
}

/** Create a directory with 0700 permissions (POSIX only). */
export function secureDirectory(path) {
  try {
    if (!existsSync(path)) mkdirSync(path, { recursive: true })
    if (process.platform !== 'win32') chmodSync(path, 0o700)
  } catch { /* best-effort */ }
}

/** Chmod a file to 0600 (POSIX only). */
export function secureFile(path) {
  try {
    if (process.platform !== 'win32') chmodSync(path, 0o600)
  } catch { /* best-effort */ }
}
