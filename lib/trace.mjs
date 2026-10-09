/**
 * Append-only hook trace.
 *
 * Purpose: make "the hook is actually mounted" observable from outside the
 * process. Every pre-step invocation, mode switch, and injected brief lands as
 * one JSON line under `$DSH_HOME/redteam-mode/hook-trace.jsonl`, so a
 * verification run can prove the hook ran instead of inferring it from a
 * model reply.
 *
 * Disable with `DSH_REDTEAM_TRACE=0`. Failures are swallowed: tracing must
 * never break a turn.
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './state.mjs'

let dirReady = false
let disabled = false

function traceDir() {
  return join(dshHome(), 'redteam-mode')
}

export function tracePath() {
  return join(traceDir(), 'hook-trace.jsonl')
}

export function hookTrace(record) {
  if (disabled || process.env.DSH_REDTEAM_TRACE === '0') {
    disabled = true
    return
  }
  try {
    if (!dirReady) {
      mkdirSync(traceDir(), { recursive: true })
      dirReady = true
    }
    appendFileSync(tracePath(), `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`, 'utf8')
  } catch {
    /* tracing is best-effort */
  }
}
