/**
 * 自循环红队验证脚本 — 模拟用户发 /redteam 命令并自动检测是否成功激活模式。
 *
 * 用法: node scripts/autoloop_verify.mjs
 * 步骤:
 *   1. 通过 DSH HTTP API (127.0.0.1:3080) 创建临时会话
 *   2. 依次发: /redteam light、/redteam full、/redteam on、/redteam off (裸命令)
 *   3. 再发一次 "命令 + 目标" 的形式: /redteam full\n<目标>
 *   4. 每次等待 agent 处理, 读会话历史检测 [mode] ACTIVE 注入 + 读 redteam 状态文件 mode
 * 不依赖用户手动发消息 —— 完全自循环。
 */
import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const BASE = 'http://127.0.0.1:3080'
const HOME = homedir()

const rpc = async (method, payload) => {
  const r = await fetch(`${BASE}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: `auto-${randomUUID().slice(0, 8)}`, method, payload }),
  })
  return r.json()
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 在会话历史里查找是否存在 kind='redteam-mode'或'redteam-brief' 的注入消息。 */
async function findInjectedHint(sessionId) {
  const h = await rpc('session.history', { sessionId, maxMessages: 50 })
  const events = h.result?.value?.events || []
  let hint = ''
  for (const ev of events) {
    const e = ev.event || {}
    // 注入的 hint 以 user 消息携带 source.kind=redteam-mode / redteam-brief
    if (e.type === 'user/message' || e.type === 'agent/inbox/spliced') {
      const msgs = e.data?.inserted || [e.data]
      for (const m of msgs) {
        const kind = m?.source?.kind || ''
        if (kind === 'redteam-mode' || kind === 'redteam-brief') {
          const txt = (m.content || []).map((b) => b.text || '').join('')
          hint += txt.slice(0, 300) + '\n'
        }
      }
    }
  }
  return hint
}

/** 读一个会话的 redteam 状态文件 mode。 */
function readStateMode(sessionId) {
  // 兼容新旧布局
  const dirs = [
    join(HOME, '.dsh', 'redteam-mode', 'state', 'sessions'),
    join(HOME, '.dsh', 'redteam-mode', 'state'),
  ]
  for (const dir of dirs) {
    const f = join(dir, `${sessionId}.json`)
    if (existsSync(f)) {
      try { return JSON.parse(readFileSync(f, 'utf8')).mode } catch { return null }
    }
  }
  // 遍历目录找 (可能 key 规整过)
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir)) {
      if (name.includes(sessionId.replace(/[^a-zA-Z0-9_.-]+/g, '_').slice(0, 120))) {
        try { return JSON.parse(readFileSync(join(dir, name), 'utf8')).mode } catch {}
      }
    }
  }
  return null
}

async function main() {
  console.log('=== redteam-mode 自循环验证 ===')
  // 1. 创建临时会话 (cwd 用插件目录)
  const created = await rpc('session.create', { cwd: 'C:/repository/dsh-redteam-mode' })
  const sessionId = created.result?.value?.sessionId
  if (!sessionId) { console.error('创建会话失败:', JSON.stringify(created)); return }
  console.log(`[1] 创建临时会话: ${sessionId}`)

  const trials = [
    { label: '/redteam light', text: '/redteam light' },
    { label: '/redteam full', text: '/redteam full' },
    { label: '/redteam on', text: '/redteam on' },
    { label: '/redteam off', text: '/redteam off' },
    { label: '/redteam full\n<目标>', text: '/redteam full\n检查 https://demo.local 的 SQL 注入并给出 PoC' },
  ]

  let pass = 0
  for (const t of trials) {
    const p = await rpc('session.prompt', { sessionId, mode: 'queue', content: [{ type: 'text', text: t.text }] })
    const accepted = p.result?.value?.accepted
    await sleep(7000) // 等 agent 处理 + hook 注入
    const hint = await findInjectedHint(sessionId)
    const mode = readStateMode(sessionId)
    const hasInject = /ACTIVE/.test(hint) || /redteam-mode|authorized-research/.test(hint)
    console.log(`[${t.label}]`)
    console.log(`   accepted=${accepted} 状态mode=${mode} 注入=${hasInject?'有':'无'}`)
    if (hasInject && mode) { pass++ } else { console.log(`   (无注入 hint: ${hint.slice(0,100)||'空'})`) }
  }

  console.log(`\n=== 结果: ${pass}/${trials.length} 条成功激活注入 ===`)
  console.log('(若全部无注入, 说明当前 DSH 进程未加载最新 index.mjs —— bundle 插件需重启或热重载才生效。)')
}

main().catch((e) => { console.error('脚本异常:', e); process.exitCode = 1 })
