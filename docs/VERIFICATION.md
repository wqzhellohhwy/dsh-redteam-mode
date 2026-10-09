# v2.0.0 验证记录（真实 DSH 进程内）

> 目标：证明"钩子挂上去了、命令能触发、预设能用"，而不是只看代码。
> 所有证据取自 2026-10-10 的一次真实运行（DSH desktop profile，Web GUI，Windows）。

## 0. 结论

| 能力 | 结论 | 关键证据 |
|---|---|---|
| bundle 装配 | ✅ | profile `package.json` 的 `dependencies` + `dsh.profile.bundles` 均有该包；`cordis.yml` 组合结果含 `redteam-mode` 与 `preset-redteam` 两行 |
| host 插件激活 | ✅ | `hook-trace.jsonl`: `{"ev":"plugin-mounted","role":"host"}` |
| 预设注册 + 预设插件激活 | ✅ | `ctx.agentPresets.list(agent)` 返回含 `{"id":"redteam","name":"红队模式","order":20}` 的预设清单；`resolve('redteam')` 成功；`compositionInventory()` 同样列出；loader `preset-redteam` 状态 `active`；trace: `{"ev":"plugin-mounted","role":"preset","defaultMode":"redteam-full"}` |
| 提示词段落注册 | ✅ | trace: `prompt-section-registered`（host + preset 各一次） |
| **agent/pre-step 钩子真的跑了** | ✅ | trace 多轮 `{"ev":"pre-step","role":"host","mode":"normal",...}`；模式激活后出现 `{"ev":"brief-injected",...}` |
| `/redteam` 命令注册 | ✅ | 运行期 `ctx.commands.list(agent)` 含 `redteam`、`opsec`；`find(agent,'redteam') === true` |
| `/redteam` 命令执行 | ✅ | `commands.execute(agent, '/redteam full 检查 http://demo.local 登录页 SQL 注入')` 返回 `kind: "success"` + `mode=redteam-full` |
| 钩子注入生效（当轮） | ✅ | 手动 dispatch `agent/pre-step` 返回的 decision 里多出一条 `source.kind = "redteam-brief"` 的 user 消息（含 `[workflow:generic-adaptive]`、`[next-action:redteam_run]`） |
| 提示词注入生效（每轮） | ✅ | 红队模式下 system-reminder 中出现 `[redteam-mode] ACTIVE (redteam-full)`、授权上下文、完整合同、`[redteam-runtime]` |
| normal 态零干扰 | ✅ | `/redteam reset` 后提示词段落回到空串，system-reminder 不再含合同 |
| **新会话端到端** | ✅ | 子代理新会话（ID `123f02c2-…`）首行 `/redteam full` → 复述出 `[mode]`、C1–C14 条款、`[operation-dispatch]` 全部标记；第二轮上下文刷新后复述出常驻层标记 |
| 工具面可用 | ✅ | `redteam_status` 返回 `{ mode, opsec_level, objective, operations }` JSON |

## 1. 复现步骤（任何一台装了 DSH 的机器）

```powershell
# ① 离线自检（不需要 DSH 在跑）
cd C:\repository\dsh-redteam-mode
node scripts/verify.mjs     # 期望 32/32 checks passed
node scripts/smoke.mjs      # 期望 21 checks passed
node scripts/schema.mjs     # 期望 28 checks passed

# ② 装配（DSH 会话内）
dev_install_package C:\repository\dsh-redteam-mode

# ③ 钩子轨迹（每轮钩子被调用都会追加一行）
Get-Content "$env:USERPROFILE\.dsh\redteam-mode\hook-trace.jsonl" -Tail 20

# ④ 命令面
#    在 GUI 里输入 /redteam status → 期望 mode=normal
#    输入 /redteam on → 期望"红队模式已开启"
```

## 2. 运行期证据原文

命令注册表（进程内查询）：

```json
{ "hasCommands": true,
  "commands": ["advisor","compact","export","feedback","goal","memory_evolve_search_files",
               "memory_review","opsec","permission","plan","redteam"],
  "findRedteam": true }
```

预设注册表（进程内查询，注意这些方法都是 async，探针忘了 `await` 会误报为空数组）：

```json
{ "list(agent)": [ { "id": "standard", "order": 1 }, { "id": "ptc", "order": 2 },
                   { "id": "minimal", "order": 3 }, { "id": "cordis", "order": 4 },
                   { "id": "redteam", "name": "红队模式", "order": 20,
                     "description": "已授权安全测试专用预设：persona 即红队合同，进入即开启红队模式；…" },
                   { "id": "clean-agent", "name": "Clean Agent", "order": 50 } ],
  "resolve(redteam)": { "id": "redteam" } }
```

——即 GUI 的预设选择器能看到并选中"红队模式"。

命令执行 + 钩子 dispatch 联合探针：

```json
[ { "step": "command", "line": "/redteam full 检查 http://demo.local 登录页 SQL 注入",
    "found": true, "kind": "success",
    "text": "红队模式已开启（mode=redteam-full, opsec=balanced）。\n...\nobjective=检查 http://demo.local 登录页 SQL 注入" },
  { "step": "pre-step", "kind": "enter", "injectedCount": 1,
    "messages": [ { "sourceKind": "user", "text": "验证登录接口是否存在注入点并给出 PoC" },
                  { "sourceKind": "redteam-brief",
                    "text": "[workflow:generic-adaptive]\n[operation-status:dispatch_pending]\n..." } ] } ]
```

钩子轨迹（节选）：

```jsonl
{"ev":"plugin-mounted","role":"host","defaultMode":"normal"}
{"ev":"plugin-mounted","role":"preset","defaultMode":"redteam-full"}
{"ev":"pre-step","role":"host","key":"session-…","mode":"normal","messages":0}
{"ev":"command","command":"redteam","input":" full 检查 http://demo.local 登录页 SQL 注入","mode":"redteam-full","ok":true}
{"ev":"pre-step","role":"preset","mode":"redteam-full","messages":2}
{"ev":"brief-injected","mode":"redteam-full","kind":"dispatch"}
{"ev":"pre-step","role":"host","mode":"redteam-full","messages":3,"alreadyInjected":true}
```

最后两行同时证明了三件事：**preset 实例命中了作用域过滤**、**brief 注入成功**、
**host 实例看到已注入内容后幂等跳过**（双挂载不会重复注入）。

## 3. 本轮发现并修掉的真实缺陷

| 缺陷 | 现象 | 修复 |
|---|---|---|
| 系统包装消息被当成安全目标 | `objective` 被写进 `<system-reminder>` 的技能目录更新文本，`[targets:/available_skills,/system-reminder]` | `lib/hooks.mjs` 增加 `SYSTEM_WRAPPER_RE` 守卫，框架自产的 user 消息（`<system-reminder>` / `<goal_round>` / `<available_skills>` / `<skill_content>`）一律不进入意图引擎，并加回归断言 |
| 中文顿号里的斜杠被当成路径 | `(是/否)`、`和/或` 被提取成 target `/否` | `lib/runtime/goal.mjs` 的 `PATH_RE` lookbehind 扩展到 CJK，并排除中文标点结尾 |
| 普通开发请求被派发成新操作 | "把 README 的中文段落改得更清楚" 被当安全目标 | 扩充 `ORDINARY_DEV_PATTERNS`（文档/注释/命名/编译/依赖等），安全词仍然是 AND-NOT 优先 |

## 4. 已知限制

- **热重载会留下历史 entry**：`dev_reload_package` 重建 fiber 时，旧 entry 会显示为
  `[failed] redteam-mode`，新 entry 以哈希 id 出现并处于 `active`。这不影响功能，
  重启后由 bundle patch 行以固定 id `redteam-mode` 干净装配。重启后的验收标准是
  `dev_plugin_status` 里只应有一条 `[active] redteam-mode`。
- **命令面依赖 UI 适配器**：没有交互式命令面（headless / ACP）时，`/redteam` 不会到达
  注册表，此时走文本兜底通道（整句或首行匹配）。
- **`clean-agent` 预设会隐藏 `redteam_*` 工具**（该预设的 `clean-tool-filter.mjs` 有意为之），
  命令面不受影响。
