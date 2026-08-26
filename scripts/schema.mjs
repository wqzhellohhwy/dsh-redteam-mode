/**
 * Tool-schema projection validator for @dsh-redteam-mode.
 *
 * Why this exists: DeepSeek's official API validator requires every function
 * tool to expose a JSON Schema whose top level is `{ type: 'object',
 * properties: {...} }`. A flat `{ name: { type, required, description } }`
 * shape (used by the original port) caused:
 *   "Invalid schema for function 'redteam_cancel': schema must be a JSON
 *    Schema of 'type: object', got 'type: null'."
 *
 * This replicates the projection DSH applies (schemaOf) and fails loudly if
 * any redteam_* tool regresses.
 *
 * Run: node scripts/schema.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert/strict'
import { redteamToolSchemas } from '../lib/tools.mjs'

let passed = 0
const check = (label, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${label}`)
  } catch (error) {
    console.error(`FAIL  ${label}: ${error.message}`)
    process.exitCode = 1
  }
}

const EXPECTED_NAMES = ['redteam_run', 'redteam_status', 'redteam_evidence', 'redteam_cancel', 'redteam_events']

console.log(`[schema] ${redteamToolSchemas.length} tools`)
check('five expected tools present', () => {
  const names = redteamToolSchemas.map((t) => t.name)
  for (const n of EXPECTED_NAMES) assert.ok(names.includes(n), `missing ${n}`)
})

for (const tool of redteamToolSchemas) {
  const label = tool.name

  check(`${label}: parameters.type === 'object'`, () => {
    assert.ok(tool.parameters, 'parameters missing')
    assert.equal(tool.parameters.type, 'object', 'top-level type must be "object" (flat schema bug)')
  })

  check(`${label}: properties is an object`, () => {
    assert.ok(tool.parameters.properties && typeof tool.parameters.properties === 'object' && !Array.isArray(tool.parameters.properties))
  })

  check(`${label}: property entries are object schemas`, () => {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.ok(spec && typeof spec === 'object', `property ${key} is not an object`)
      assert.equal(typeof spec.type, 'string', `property ${key} lacks type`)
    }
  })

  check(`${label}: required is an array when present`, () => {
    const r = tool.parameters.required
    if (r !== undefined) assert.ok(Array.isArray(r), 'required must be an array')
  })

  check(`${label}: no flat legacy shape (required:true in property)`, () => {
    for (const [key, spec] of Object.entries(tool.parameters.properties)) {
      assert.notEqual(spec.required, true, `property ${key} still uses legacy required:true`)
    }
  })

  if (tool.parameters.additionalProperties !== undefined) {
    check(`${label}: additionalProperties is boolean`, () => {
      assert.equal(typeof tool.parameters.additionalProperties, 'boolean')
    })
  }
}

// Deep-nesting sanity: redteam_run.observation must itself be a valid object schema.
const run = redteamToolSchemas.find((t) => t.name === 'redteam_run')
check('redteam_run.observation is a nested object schema', () => {
  const obs = run.parameters.properties.observation
  assert.equal(obs.type, 'object')
  assert.ok(Array.isArray(obs.required) && obs.required.includes('action_id'))
  assert.ok(Array.isArray(obs.required) && obs.required.includes('summary'))
})

console.log(`\n${passed} schema checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`)
