# @dsh-external/dsh-redteam-mode

DSH 原生移植版 [codex-redteam-mode](https://github.com/chAng-L19/codex-redteam-mode) v2.1.0。
把"钩子强制 + 意图编译 + 持久化运行时"的红队模式架构完整搬进 DeepSeek Harness，并用 DSH 的进程内能力替换了原版的三个外挂件。

## 架构映射（Codex → DSH）

| Codex 原版机制 | DSH 实现 | 改进 |
|---|---|---|
| SessionStart / UserPromptSubmit 外部 hook 进程 | `ctx.on('agent/session-start')` + `agent/pre-step` 瀑布监听 | 进程内零开销；hook 崩溃自动放行不阻塞会话 |
| `model_instructions_file` 写 config.toml 注入系统提示词 | 模式激活时注入一条持久 activation 消息（契约+档案+授权上下文） | 不碰宿主配置；随会话历史天然持久 |
| 127.0.0.1:8765 回环改写代理（含伪造对话历史） | pre-step 内联改写：Research Brief + 编号 Clause + 锚点保全校验逻辑同源 | 无网络跳数、无伪造历史；上下文注入即可达成同等锚定效果且更稳 |
| stdio MCP runtime server + mcp_servers 配置 | 原生注册 `redteam_*` 五工具 | ToolBroker 经 `ctx.tools.execute` 直调任意已注册 DSH 工具 |
| ToolBroker MCP tools/list 发现 | `ctx.tools.get()` 实时解析能力→工具映射 | 能力缺失自动降级为 host-only handoff（保留原 next_action_spec 契约） |

## 强制手段（与原版对齐）

- **模式命令全匹配**才生效（`/redteam full|light|on|off`、`开启/退出红队模式`、`/opsec strict|balanced`），句中出现的同形词绝不误触发。
- normal 态**零干扰**：普通开发请求原样通过。
- redteam-light/full 态下安全意图轮次被编译为编号 Clause 的 Research Brief 并以 user-role 消息注入当轮——模型无法跳过自己这轮的输入。
- 目标编译提取 URL/IP/主机/路径为 targets，敏感值（key/token/password）先脱敏再入契约。
- generic-adaptive 七阶段工作流（map-surface → build-hypotheses → validate-path → prove-impact → review-coverage → cleanup → report），证据血缘图 + TerminalJudge 终局门禁：必需工件未验证不得完成。

## 相对原版的效果增强

1. **语义终审**：TerminalJudge 通过捕获到的 llm 路由调用模型做工件级语义核验（原版仅启发式），不可用时自动降级回启发式。
2. **每轮 token 更省**：激活消息只发一次（契约+档案），后续轮次仅注轻量 brief 行；原版把全部系统层内容常驻每个请求。
3. **会话隔离**：状态按 session id 落盘 `$DSH_HOME/redteam-mode/state/<session>.json`，操作台账在 `operations/`（JSON + events.jsonl），并行会话互不可见，重启可恢复。
4. **首轮prefill纪律**：五工具 schema 全部短描述，细节进 tool result。

## 使用

```
/redteam light        # 进入红队模式（light）
/redteam full         # 完全态
/opsec strict         # 收紧 OPSEC
<安全目标描述>          # 自动编译为 Research Brief 并调度
redteam_run {objective}   # 显式启动/推进操作（也可让模型自主调用）
redteam_status / redteam_evidence / redteam_events / redteam_cancel
/redteam off          # 退出，恢复正常工程行为
```

## 开发

```bash
bash scripts/build.sh     # 零构建校验：语法检查 + 入口导入 smoke + 资源存在性
node scripts/smoke.mjs    # 22 项已知答案回归
```

纯 ESM、零第三方依赖（llm 服务运行期按需动态解析）。热重载：改 lib/*.mjs → `dev_reload_package`。

## 结构

```
lib/index.mjs            插件入口：事件接线 + 工具注册
lib/parser.mjs           模式命令解析（全匹配语义）
lib/intent.mjs           意图引擎：场景/风险/taxonomy/Clause 编译
lib/state.mjs            会话状态机 + JSON 持久化
lib/controller.mjs       process_turn 移植（dispatch/resume/terminal 分流）
lib/profiles.mjs         模型族 → 补充档案路由（fnmatch，数据表可扩）
lib/runtime/goal.mjs     GoalContract 编译器（目标提取+脱敏）
lib/runtime/workflow.mjs generic-adaptive 工作流规格（内嵌 TOML 等价数据）
lib/runtime/store.mjs    操作台账（幂等键 + 事件流）
lib/runtime/broker.mjs   ToolBroker：能力→DSH 工具直调/host-only 回传
lib/runtime/evidence.mjs 证据血缘图
lib/runtime/judge.mjs    语义核验 + TerminalJudge
lib/runtime/operations.mjs 运行时门面（start/runBatch/cancel/events）
resources/               instruction.ctf.md + Jailbreak.*.md + boundary-policy（原版资产原样保留）
scripts/build.sh         零构建校验
scripts/smoke.mjs        已知答案回归
```

## 边界声明

本插件继承原版 MIT 授权与用途边界：仅用于已授权的安全评估工作流。`resources/skills/SKILL.md`（redteam-boundary-policy）定义操作边界；不可逆动作仍要求显式确认（authorized-research-context 第 5 条）。
