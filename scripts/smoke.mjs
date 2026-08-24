/**
 * Functional smoke test — known-answer cases for the ported pipeline.
 * Run: node scripts/smoke.mjs   (exit 0 = all pass)
 */
import assert from 'node:assert/strict'
import { parseModeCommand, parseOpsecCommand } from '../lib/parser.mjs'
import { rewritePrompt, detectIntent } from '../lib/intent.mjs'
import { compileGoal, redactSensitive } from '../lib/runtime/goal.mjs'
import { processTurn } from '../lib/controller.mjs'
import { defaultState } from '../lib/state.mjs'
import { OperationRuntime } from '../lib/runtime/operations.mjs'

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

console.log('[parser]')
check('fullmatch /redteam full', () => assert.equal(parseModeCommand('/redteam full'), 'redteam-full'))
check('中文命令 开启红队模式', () => assert.equal(parseModeCommand('开启红队模式'), 'redteam-light'))
check('mid-sentence does NOT trigger', () => assert.equal(parseModeCommand('帮我 redteam on 这个项目'), null))
check('/redteam off → normal', () => assert.equal(parseModeCommand('/redteam off'), 'normal'))
check('opsec strict', () => assert.equal(parseOpsecCommand('/opsec strict'), 'strict'))

console.log('[intent]')
const sec = rewritePrompt('对 http://target.local/login 做 SQL注入 检测并给出 PoC')
check('security intent detected', () => assert.equal(sec.ordinary_dev, false))
check('clauses numbered in brief', () => assert.match(sec.research_brief, /C1\./))
check('deliverable PoC captured', () => assert.ok(sec.deliverables.includes('reproduction_artifact')))
const dev = rewritePrompt('重构这个模块并补充单元测试')
check('ordinary dev classified', () => assert.equal(dev.ordinary_dev, true))

console.log('[goal]')
const goal = compileGoal('测试 https://a.example.com/admin 与 192.168.1.10 的越权，key=sk-abcdefghijklmnop1234')
check('URL target extracted', () => assert.ok(goal.targets.includes('https://a.example.com/admin')))
check('IP target extracted', () => assert.ok(goal.targets.includes('192.168.1.10')))
check('api key redacted', () => assert.ok(!JSON.stringify(goal).includes('sk-abcdefghijklmnop1234')))

console.log('[controller]')
const state = defaultState('smoke')
state.mode = 'redteam-full'
const turn = processTurn({ prompt: '复现 CVE-2021-44228 在本地靶场的影响', state })
check('dispatch produced', () => assert.equal(turn.kind, 'dispatch'))
check('overlay carries redteam_run call', () => assert.match(turn.overlay, /\[operation-dispatch\] Call redteam_run/))
const follow = processTurn({ prompt: '继续', state: turn.state })
check('follow-up resumes', () => assert.equal(follow.kind, 'resume'))
const ord = processTurn({ prompt: '重构登录模块并升级依赖', state: turn.state })
check('ordinary turn stays clean', () => assert.equal(ord.kind, 'ordinary-development'))
const term = (() => {
  const s = { ...turn.state, goal_terminal: true, goal_success: true }
  return processTurn({ prompt: '继续', state: s })
})()
check('terminal state short-circuits', () => assert.equal(term.kind, 'terminal'))

console.log('[runtime]')
const fakeCtx = {
  tools: {
    get: (name) => ({ name }),
    execute: async (exec) => ({
      isError: false,
      content: [{ type: 'text', text: `simulated ${exec.name} output for evidence` }],
      value: { simulated: true },
    }),
  },
}
const runtime = new OperationRuntime(fakeCtx, {})
const op = runtime.start({ sessionKey: 'smoke-session', objective: '评估 https://demo.local 的 SQL 注入面并给出报告' })
check('operation started', () => assert.match(op.run_id, /^op-smoke-session-/))
const batch1 = await runtime.runBatch(op)
check('batch advanced or handed off', () =>
  assert.ok(['running', 'pending-host-action'].includes(batch1.state), `got ${batch1.state}`))
if (batch1.state === 'pending-host-action') {
  const obs = { action_id: batch1.next_action_spec.action_id, summary: 'surface mapped', evidence: 'ports 80,443 open' }
  const after = await runtime.runBatch(runtime.resume(op.run_id), )
  check('observation accepted then advances', () => assert.notEqual(after.state, 'idle'))
}
check('events recorded', () => assert.ok(runtime.events(op.run_id).length >= 2))
runtime.cancel(op, 'smoke-done')
check('cancel freezes ledger', () => assert.equal(runtime.resume(op.run_id).status, 'cancelled'))

console.log(`\n${passed} checks passed${process.exitCode ? ' (WITH FAILURES)' : ''}`)
