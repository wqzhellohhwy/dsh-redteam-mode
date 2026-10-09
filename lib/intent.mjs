/**
 * Intent engine — faithful port of codex-redteam-mode hooks/core/intent_engine.py.
 * Classifies each user turn, splits it into numbered Clauses, and compiles a
 * lossless Research Brief (anchors preserved verbatim).
 */
import { createHash } from 'node:crypto'

export const sha256 = (text) => createHash('sha256').update(String(text), 'utf8').digest('hex')

// ── Scene detection (secondary to the requested action) ──────────────────────
const SCENE_PATTERNS = [
  ['ctf', [/\bctf\b/, /\bpwn\b/, /夺旗/, /靶场题?/]],
  ['reverse', [/\breverse\b/, /\bbinary\b/, /\bapk\b/, /逆向/, /反编译/, /固件/]],
  ['ir', [/\bforensics?\b/, /\bincident\b/, /\bioc\b/, /取证/, /应急/, /溯源/, /恶意样本/]],
  ['crypto', [/\bcrypto\b/, /\brsa\b/, /\baes\b/, /密码学/, /解密/, /哈希/]],
  ['audit', [/\baudit\b/, /source[- ]?code/i, /代码审计/, /源码/, /数据流/]],
  ['model', [/\bllm\b/, /prompt[- ]?injection/i, /jailbreak/i, /模型安全/, /提示词/, /越狱/]],
  ['pentest', [/\bpentest\b/i, /\brecon\b/i, /\bnmap\b/i, /渗透/, /扫描/, /探测/, /web\s*shell/i, /webshell/i, /一句话木马/, /免杀/, /哥斯拉/]],
  ['tool', [/\bscanner\b/i, /\bfuzzer\b/i, /工具开发/, /脚本/, /自动化/]],
  ['vuln', [/\bcve-\d+/i, /\bsqli\b/i, /\bxss\b/i, /\bssrf\b/i, /漏洞/, /注入/, /越权/]],
]

const SECURITY_INTENT_PATTERNS = [
  /漏洞|注入|越权|渗透|红队|靶场|复现|利用|攻击面|安全测试|安全验证|PoC|exploit/i,
  /\bcve-?\d{4}-\d+\b|\bsqli\b|\bxss\b|\bssrf\b|\brce\b|\bwebshell\b/i,
  /web\s*shell|一句话木马|免杀|哥斯拉|规避检测|绕过(?:检测|WAF|限制)/i,
  /检测规则|回归测试.*(?:漏洞|安全)|攻击链|权限提升|横向移动/,
  /vulnerabilit(?:y|ies)|penetration\s+test|security\s+(?:audit|test|validation)|privilege\s+escalation/i,
  /detection\s+evasion|credential\s+access|lateral\s+movement|bypass\s+(?:detection|WAF|guardrail)/i,
]

const ORDINARY_DEV_PATTERNS = [
  /优化.*(?:SQL|查询|索引|执行计划)/,
  /减少全表扫描|提升查询性能|慢查询/,
  /重构|部署|调试|单元测试|类型检查|格式化|依赖升级/,
  /修复.*(?:参数绑定|ORM|查询构造).*(?:问题|错误|性能)/,
  /optimi[sz]e.*(?:SQL|query|index|execution\s+plan)/i,
  /full\s+table\s+scan|query\s+performance|slow\s+quer(?:y|ies)/i,
  /refactor|deploy|debug|unit\s+test|type\s+check|format(?:ting)?|dependency\s+upgrade/i,
  /fix.*(?:parameter\s+binding|ORM|query\s+construction).*(?:issue|error|performance)/i,
  // Plain software work that has nothing to do with a security objective. The
  // security patterns above still win (`isOrdinaryDev` is an AND-NOT), so this
  // never swallows a real assessment turn; it only stops documentation, code
  // cleanup, and packaging requests from being dispatched as new operations.
  /(?:修改|改进|改写|完善|补充|整理|翻译|清理|调整|美化|排版|重命名|迁移|编译|打包|提交|合并).{0,16}(?:文档|注释|说明|readme|代码|脚本|命名|排版|版本号|变更日志|changelog)/i,
  /\breadme\b|\bchangelog\b|\bjsdoc\b|文档|注释|排版|代码风格/i,
  /lint|prettier|eslint|tsconfig|package\.json|依赖|devDependencies/i,
]

const TAXONOMY_PATTERNS = [
  ['CWE-89', [/SQL\s*注入/, /SQL\s+injection/i, /\bSQLi\b/i], '数据库查询构造边界验证'],
  ['CWE-79', [/跨站脚本/, /\bXSS\b/i, /脚本注入/], '输出编码与 DOM 写入边界验证'],
  ['CWE-918', [/服务端请求伪造/, /\bSSRF\b/i, /内网探测/], '服务端出站请求边界验证'],
  ['CWE-862', [/权限绕过|鉴权绕过|访问控制/, /\bauth(?:n|z)?\b/i], '对象与角色访问控制边界验证'],
  ['CWE-94', [/远程代码执行/, /\bRCE\b/i], '代码生成与执行边界验证'],
]

const HIGH_RISK_PATTERNS = [
  /免杀|web\s*shell|webshell|一句话木马|哥斯拉|规避检测|持久化|凭据获取|横向移动/,
  /detection\s+evasion|persistence|credential\s+access|lateral\s+movement|godzilla/i,
]

const CLAUSE_SPLIT_RE = /(?:\r?\n)+|[;；。]+|\s+(?:and\s+then|then|plus)\s+|(?:然后|并且|同时|最后|再(?:进行|执行|验证|生成|输出))/gi

const EXPLICIT_REVISE_RE = /^\s*(?:new\s+objective|revise\s+objective|新的目标|新目标|目标改为|只测试|仅测试)\s*[:：]?\s*/i
const FOLLOWUP_RE = /^\s*(?:继续|接着|下一步|然后呢|再试一次|按上面|基于上面|换一个参数|continue|keep going|next step)/i
const SUMMARY_RE = /^\s*(?:总结|汇总|生成报告|输出报告|summari[sz]e|report)/i
const VERIFY_RE = /^\s*(?:验证|复现|确认|评估|verify|validate|reproduce|confirm|assess|evaluate)/i
const GENERATE_RE = /生成|创建|编写|构造|实现|generate|create|write|produce|implement/i
const EXECUTION_RE = /执行|运行|验证|复现|发包|探测|扫描|测试|利用|构建|生成|修复|部署|execute|run|perform|verify|reproduce|scan|probe|test|build|generate|deploy/i
const CONFIG_RE = /AGENTS(?:\.md)?|hooks?(?:\.json)?|config\.toml|安装|配置|工作流|prompt\s*rewrite/i

const DELIVERABLE_PATTERNS = [
  ['request_response', /请求.{0,8}响应|request.{0,8}response/i],
  ['reproduction_artifact', /\bPoC\b|复现|验证脚本|reproduction/i],
  ['finding_report', /报告|report|finding/i],
  ['patch', /修复|补丁|patch|fix/i],
  ['detection', /检测规则|检测器|rule|detection/i],
  ['script', /脚本|代码|script|code/i],
]

const anyMatch = (text, patterns) => patterns.some((p) => p.test(text))

function splitClauses(prompt) {
  const parts = String(prompt)
    .split(new RegExp(CLAUSE_SPLIT_RE.source, 'gi'))
    .map((p) => p.replace(/^[\s,，]+|[\s,，]+$/g, ''))
    .filter((p) => p.length > 0)
  return parts.length > 0 ? parts : [String(prompt).trim()]
}

const isOrdinaryDev = (prompt) => anyMatch(prompt, ORDINARY_DEV_PATTERNS) && !anyMatch(prompt, SECURITY_INTENT_PATTERNS)

function riskLevel(prompt, ordinaryDev) {
  if (ordinaryDev) return 'low'
  if (anyMatch(prompt, HIGH_RISK_PATTERNS)) return 'high'
  if (anyMatch(prompt, SECURITY_INTENT_PATTERNS)) return 'research'
  return 'low'
}

function detectScene(prompt, ordinaryDev) {
  if (ordinaryDev) return 'general'
  for (const [name, patterns] of SCENE_PATTERNS) {
    if (patterns.some((p) => p.test(prompt))) return name
  }
  return 'general'
}

function detectTaxonomy(prompt) {
  const values = []
  for (const [name, patterns] of TAXONOMY_PATTERNS) {
    if (patterns.some((p) => p.test(prompt))) values.push(name)
  }
  return values
}

/**
 * Compact defensive wording for ordinary/research validation tasks. Explicit
 * high-risk generation requests stay transparent so the rewrite can never
 * silently change the requested operation.
 */
function surfaceDescription(text, { risk_level: risk, ordinary_dev: ordinary }) {
  if (ordinary || risk === 'high') return text
  let normalized = text
  for (const [, patterns, description] of TAXONOMY_PATTERNS) {
    for (const pattern of patterns) {
      normalized = normalized.replace(new RegExp(pattern.source, 'gi'), description)
    }
  }
  return normalized
}

function actionKind(prompt, ordinaryDev) {
  let text = prompt.replace(/^\s*C\d+\.\s*/i, '')
  if (CONFIG_RE.test(text)) return 'meta'
  if (SUMMARY_RE.test(text) && text.length <= 96) return 'report'
  if (VERIFY_RE.test(text)) return 'verify'
  if (ordinaryDev && /优化|重构|性能|调试|部署|升级|optimi[sz]e|refactor|performance|debug|deploy|upgrade/i.test(text)) return 'optimize'
  if (GENERATE_RE.test(text)) return 'generate'
  if (EXECUTION_RE.test(text)) return 'execute'
  return 'analyze'
}

function contextBundle(scene, ordinaryDev) {
  if (ordinaryDev) return ['implementation', 'benchmark', 'tests']
  if (scene === 'general') return ['analysis', 'evidence', 'validation']
  return ['defensive_analysis', 'evidence', 'validation']
}

const detectDeliverables = (prompt) =>
  DELIVERABLE_PATTERNS.filter(([, pattern]) => pattern.test(prompt)).map(([name]) => name)

/** Compile one turn into a numbered-clause Research Brief. */
export function rewritePrompt(prompt) {
  const original = String(prompt ?? '').trim()
  const clauses = splitClauses(original)
  const ordinaryDev = isOrdinaryDev(original)
  const risk = riskLevel(original, ordinaryDev)
  const scene = detectScene(original, ordinaryDev)
  const action = actionKind(original, ordinaryDev)
  const deliverables = detectDeliverables(original)
  const taxonomy = detectTaxonomy(original)
  const bundle = contextBundle(scene, ordinaryDev)

  const rendered = clauses.map(
    (clause, i) => `C${i + 1}. ${surfaceDescription(clause, { risk_level: risk, ordinary_dev: ordinaryDev })}`,
  )
  if (deliverables.length > 0) rendered.push(`Required deliverables: ${deliverables.join(', ')}.`)
  rendered.push(
    ordinaryDev
      ? 'For each change, provide an implementation check and a reproducible benchmark or test.'
      : 'For each completed Clause, produce tool-derived evidence and a reproducible validation plan.',
  )

  return {
    original_text: original,
    original_sha256: sha256(original),
    clauses,
    scene,
    action_kind: action,
    execution_required: EXECUTION_RE.test(original),
    deliverables,
    research_brief: rendered.join('\n'),
    ordinary_dev: ordinaryDev,
    risk_level: risk,
    taxonomy,
    context_bundle: bundle,
  }
}

export function renderRewriteContext(rewrite) {
  return (
    '[prompt-rewrite]\n' +
    `original_sha256=${rewrite.original_sha256}; scene=${rewrite.scene}; action_kind=${rewrite.action_kind}; ` +
    `ordinary_dev=${String(rewrite.ordinary_dev).toLowerCase()}; risk_level=${rewrite.risk_level}; ` +
    `taxonomy=${rewrite.taxonomy.join(',') || 'none'}; ` +
    `context_bundle=${rewrite.context_bundle.join(',') || 'none'}\n` +
    `${rewrite.research_brief}\n` +
    'Preserve every Clause, concrete anchor, constraint, and deliverable. ' +
    'The original user message remains the semantic authority.'
  )
}

const summaryOnly = (text) => SUMMARY_RE.test(text) && splitClauses(text).length === 1 && text.length <= 96

/** Carry previous scene/action context for short follow-up turns. */
function inheritFollowupContext(rewrite, state, intentType) {
  if (!state.last_scene && !state.last_action_kind) return rewrite
  let actionKindValue = rewrite.action_kind
  if (intentType === 'continue' && state.last_action_kind) actionKindValue = state.last_action_kind
  return {
    ...rewrite,
    scene: state.last_scene || rewrite.scene,
    action_kind: actionKindValue,
    risk_level: state.last_risk_level || rewrite.risk_level,
    taxonomy: (state.last_taxonomy?.length ? state.last_taxonomy : rewrite.taxonomy),
    context_bundle: (state.last_context_bundle?.length ? state.last_context_bundle : rewrite.context_bundle),
  }
}

/**
 * Decide what this turn means for the operation.
 * Returns {intent_type, objective_delta?, should_refresh_taskbook?, should_verify_now?, rewrite}.
 */
export function detectIntent(prompt, state) {
  const text = String(prompt ?? '').trim()
  const rewrite = rewritePrompt(text)
  if (!state.objective) {
    return { intent_type: 'new', objective_delta: text, should_refresh_taskbook: true, rewrite }
  }
  const reviseMatch = EXPLICIT_REVISE_RE.exec(text)
  if (reviseMatch) {
    const objective = text.slice(reviseMatch[0].length).trim() || text
    return { intent_type: 'revise', objective_delta: objective, should_refresh_taskbook: true, rewrite }
  }
  if (summaryOnly(text)) {
    return { intent_type: 'summarize', rewrite: inheritFollowupContext(rewrite, state, 'summarize') }
  }
  if (VERIFY_RE.test(text) && text.length <= 160) {
    return { intent_type: 'verify', should_verify_now: true, rewrite: inheritFollowupContext(rewrite, state, 'verify') }
  }
  if (FOLLOWUP_RE.test(text)) {
    return { intent_type: 'continue', rewrite: inheritFollowupContext(rewrite, state, 'continue') }
  }
  return { intent_type: 'new', objective_delta: text, should_refresh_taskbook: true, rewrite }
}
