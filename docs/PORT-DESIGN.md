# dsh-redteam-mode — 移植设计文档（知识库）

> 面向维护者/贡献者：本文件记录 codex-redteam-mode → DSH 插件的架构映射、强制手段实现、一次关键 bug 修复的根因，以及可移植性约定。普通用户看根目录 `README.md` 即可。

## 1. 项目定位

`dsh-redteam-mode` 是 [codex-redteam-mode](https://github.com/chAng-L19/codex-redteam-mode)（v2.1.0）在 **DeepSeek Harness (DSH)** 上的原生移植。它把原版"钩子强制 + 意图编译 + 持久化运行时"的红队模式架构搬进 DSH 插件体系，用于**已授权**的安全评估工作流。

核心思想：不是靠一句系统提示词劝模型"放开限制"，而是通过三层**结构性强制**让模式切换全匹配、安全意图被编译、每轮输入被锚定，再配一个可断点续跑的证据驱动运行时。

## 2. 架构映射（Codex → DSH）

| Codex 原版机制 | DSH 实现 | 备注/改进 |
|---|---|---|
| SessionStart 外部 hook 进程 | `ctx.on('agent/session-start')` | 进程内预载持久状态，零开销 |
| UserPromptSubmit hook | `ctx.on('agent/pre-step')` 瀑布 | 拦截前先 `await next()` 放行，再改写消息；hook 抛错自动 pass-through，不阻塞会话 |
| `model_instructions_file` 写 config.toml 注入系统提示词 | 模式激活时注入一条持久 activation 消息（user-role） | 不碰宿主配置；随会话历史天然持久 |
| 127.0.0.1:8765 回环改写代理（含伪造对话历史） | pre-step 内联改写：Research Brief + 编号 Clause + 锚点保全 | 无网络跳数、无伪造历史，用当前轮注入达成同等锚定 |
| stdio MCP runtime server + mcp_servers 配置 | 原生注册 `redteam_*` 五工具 | 见 §4 工具面 |
| ToolBroker MCP tools/list 发现 | `ctx.tools.get()` / `ctx.tools.execute()` 实时直调 | 能力缺失自动降级为 host-only handoff（保留 next_action_spec 契约） |

## 3. 四层强制手段（与原版对齐）

1. **模式命令全匹配**：`/redteam full|light|on|off`、`开启/退出红队模式`、`/opsec strict|balanced` 仅在**整句精确匹配**时生效；句中同形词绝不误触发（有单测锁定）。
2. **normal 态零干扰**：普通开发轮次原样通过。
3. **激活态输入锚定**：安全意图轮次被意图引擎编译为编号 Clause 的 Research Brief，并以 user-role 消息注入**当轮**——模型无法跳过自己这轮的输入。
4. **目标编译 + 脱敏**：提取 URL/IP/主机/路径为 targets；key/token/password 先脱敏再入契约。

运行时遵循 generic-adaptive 七阶段工作流（map-surface → build-hypotheses → validate-path → prove-impact → review-coverage → cleanup → report），证据血缘图 + TerminalJudge 终局门禁：必需工件未验证不得完成。

## 4. 工具面（原生 `redteam_*` 五工具）

`redteam_run / redteam_status / redteam_evidence / redteam_cancel / redteam_events`。

**关键约束**：DSH 的 `schemaOf()` 对 `ctx.tools.register()` 的 `parameters` **不做格式转换**（只有 `defineTool()` 内部才转）。DeepSeek 官方 API 校验器要求每个函数工具 schema 顶层必须是 `{ type: 'object', properties: {...} }`。

### Bug 记录（务必规避）
早期版本工具参数用平铺格式 `{ run_id: {type, required, description} }`，无顶层 `type:'object'`，导致官方 API 拒绝整个请求：

```
Invalid schema for function 'redteam_cancel':
schema must be a JSON Schema of 'type: object', got 'type: null'.
```

> OpenRouter / GLM 等宽松网关不报错，所以早期用第三方模型测试不暴露此问题；只有直连 DeepSeek 官方 API 才触发。

**修复规范**（已固化到 `lib/tools.mjs`）：
- 顶层 `parameters.type === 'object'` + `properties`；
- 嵌套属性把 `required: true` **上提**为该层 `required: ['prop', ...]` 数组；
- 嵌套对象（如 `observation`）自身也是合法 object schema。

用 `node scripts/schema.mjs` 复现 DSH `schemaOf` 投影并断言全部工具合规；任何工具改动后必须重跑。

## 5. 运行时与持久化

- **状态机**：`lib/state.mjs` — 按 session id 落盘 JSON，含 mode/opsec/目标/意图/工作流进度/激活序号。
- **操作台账**：`lib/runtime/store.mjs` — 每操作一个 JSON + append-only events.jsonl（幂等键 + 事件流）。
- **语义终审**：`lib/runtime/judge.mjs` — 捕获 `llm/stream` 路由后调用模型做工件级语义核验；不可用时自动降级回启发式。
- **ToolBroker**：`lib/runtime/broker.mjs` — 经 `ctx.tools.execute()` 进程内直调任意已注册 DSH 工具；无对应工具则回传 host-only next_action_spec。

## 6. 可移植性约定（重要）

**代码内无任何本机硬编码路径**。路径解析规则：

| 用途 | 解析逻辑 | 覆盖 |
|---|---|---|
| DSH 根目录 | `process.env.DSH_HOME` 缺省 `~/.dsh` | 任意 DSH 安装 |
| 会话状态目录 | `$DSH_HOME/redteam-mode/state/` | `process.env.DSH_REDTEAM_STATE_DIR` |
| 操作台账目录 | `$DSH_HOME/redteam-mode/operations/` | `process.env.DSH_REDTEAM_OPS_DIR` |
| 提示词资源 | 由 `import.meta.url` 相对推导 `resources/` | 随包迁移 |

贡献新功能时请遵循：**不引入绝对路径、不使用 `$HOME`/用户名拼接、不把本机会话数据提交进仓库**（`.gitignore` 已忽略 `*.bak`、`*.tmp`、运行态目录）。

## 7. 构建与测试

```bash
bash scripts/build.sh      # 零构建校验：语法 + 入口导入 smoke + 资源存在性
node scripts/smoke.mjs     # 22 项已知答案回归（解析/意图/目标/控制器/运行时）
node scripts/schema.mjs    # 工具 schema 投影断言（§4 的 bug 防线）
```

纯 ESM、零第三方依赖（llm 服务运行期按需动态解析）。

## 8. 授权与边界

继承原版 MIT 授权与用途边界：**仅限已授权安全评估**。`resources/skills/SKILL.md`（redteam-boundary-policy）定义操作边界；不可逆动作仍需显式确认（authorized-research-context 第 5 条）。

---

## 9. DSH 2.0 改造（v2.0.0）

### 9.1 "钩子挂不上去"的真实根因

排查结论（按影响排序）：

1. **插件从未被装配**。profile 的 `dependencies` / `dsh.profile.bundles` / `cordis.patch.yml`
   三处都没有它，`node_modules` 里也没有链接，`$DSH_HOME/redteam-mode/` 连状态目录都没生成过。
   钩子代码写得再对，也从来没被执行——第一优先级永远是"先确认它在 loader 里"。
2. **预设形态已换代**。旧版把预设写成目录 `$DSH_HOME/.agent-presets/<id>/`（`preset.yml` +
   `agent.cordis.yml`）。DSH 0.2 起预设改为 `@deepseek-ai/dsh-agent-preset` 的 **loader 声明行**，
   目录扫描被删除，旧目录不会被任何代码读取。
3. **没有命令面**。旧实现只能靠在 `agent/pre-step` 里对整句文本做全匹配来切模式，
   交互上等于"发了命令没反应"，容易被判断成钩子失效。
4. **作用域过滤**。即使挂上了，DSH 的 agent 事件是 scope-filtered 的：不带 `{ global: true }`
   的监听器会在运行前被丢弃。这一点在旧代码注释里已经猜到，但当时没有可运行的装配去验证。

### 9.2 v2.0 的三层接线

| 层 | API | 职责 |
|---|---|---|
| 命令层 | `ctx.commands.register()` | `/redteam`、`/opsec` 直接改会话状态，零 token、零模型消息 |
| 提示词层 | `ctx.systemPrompt.section({ text: (ctx) => … })` | 模式激活时渲染红队合同；`normal` 态返回空串，段落自动消失 |
| 每轮钩子层 | `ctx.on('agent/pre-step', h, { global: true })` | 编译当轮安全目标为 Research Brief + 操作派发，普通轮次原样放行 |

三者都在 `apply()` 内通过 `ctx.effect` / `ctx.on` / `ctx.inject` 注册，卸载即整体清理。

### 9.3 0.2 API 事实（本机实测，非推测）

- **agent 事件的 scope 过滤**：`agentEvents` 用 `scopeTarget(agent, agent)` 作为 dispatch 的
  `thisArg`；`EventsService.dispatch()` 里 `hooks.filter(h => h.global || !filter || filter(h.ctx))`。
  所以跨作用域监听必须 `{ global: true }`；**不带** `global` 的监听天然只对命中该作用域的 agent 生效
  ——这正是 preset 挂载想要的语义。
- **`agent/pre-step`**：waterfall，payload `{ agent, messages, turn, step, signal }`，
  默认 decision `{ kind: 'enter', messages }`；改写时必须展开原 decision 以保留其它字段。
- **`agent/created`**：serial，payload `{ agent, source, signal }`，用于预载状态与迁移。
- **命令面**：`ctx.commands.register({ name, description, input: { hint }, handler })`；
  handler 收到 `{ commandId, agent, rawInput, attachments, signal }`，返回
  `{ kind: 'success' | 'error', text }`。命令**不产生模型消息**，所以切换模式是瞬时的。
  默认全局注册；要限定到单个 agent，需把 `commands` 放进插件 `inject` 并挂在该 agent 的上下文下。
- **提示词段落**：`text` 可以是函数，每次 `assemble()` 求值；**空段落会从提示词里消失**，
  这是"normal 态零干扰"得以成立的关键。
- **消息结构**：`MessageBase = { id, content, source }`，user 消息再加 `role: 'user'`；
  `source.kind` 是自定义来源标记（本插件用 `redteam-brief` / `redteam-mode`），
  UI 与后续钩子据此识别"这条不是用户写的"。
- **`ctx.inject([deps], cb)`** 是可选依赖的正确姿势：缺服务的 profile 只是跳过该回调，
  而不是让整个插件激活失败。

### 9.4 双挂载与幂等

`cordis.patch.yml` 插入两行：

```yaml
- id: redteam-mode          # role: host —— 工具/命令/全局钩子
- id: preset-redteam        # @deepseek-ai/dsh-agent-preset，内含 role: preset 的子行
```

两个实例共享 `lib/session.mjs` 的进程内会话缓存，以及 `lib/hooks.mjs` 的 `seen` 集合；
再加一道"本轮已存在 `redteam-brief` 就跳过"的检查，所以同一轮永远不会被注入两次。
实测轨迹里 `preset` 先注入、`host` 紧接着 `alreadyInjected: true` 跳过，即为该机制的现场证据。

### 9.5 文件迁移对照

| 旧 | 新 | 说明 |
|---|---|---|
| `lib/index.mjs` | `lib/index.js` | 入口改名以匹配 `main`/`exports`；旧实现留在 `lib/index.v1.mjs.bak` |
| — | `lib/commands.mjs` | 命令面（新增） |
| — | `lib/prompt.mjs` | 动态提示词合同（新增，替代旧 activation 消息） |
| — | `lib/hooks.mjs` | 钩子从入口拆出，含幂等与系统消息守卫（新增） |
| — | `lib/session.mjs` | 会话状态缓存与 pending 迁移（新增） |
| — | `lib/trace.mjs` | 钩子轨迹，让"钩子跑没跑"可外部观测（新增） |
| — | `scripts/verify.mjs` | 离线装配 + 行为验证 32 项（新增） |
| `cordis.patch.yml`（1 行 insert） | 2 行（插件行 + 预设行） | 预设晋升为一等公民 |

### 9.6 可观测性约定

`$DSH_HOME/redteam-mode/hook-trace.jsonl` 是刻意留下的验证面：每条 `pre-step`、`command`、
`brief-injected`、`plugin-mounted` 都落一行 JSON。判断"钩子是否挂上"时**不要**看模型回复，
直接看这个文件——`DSH_REDTEAM_TRACE=0` 可关闭。

