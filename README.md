# dsh-redteam-mode

给 **DeepSeek Harness (DSH)** 加一个"红队模式"开关的插件（**2.0 版**）。

两种进入方式，任选其一：

- **命令方式**：在任何会话里输入 `/redteam on`（轻量）/ `/redteam full`（完全态），用完 `/redteam off` 关掉。
- **预设方式**：在会话的"预设"里选 **红队模式**，新会话一开就是红队状态（提示词即合同、默认模式已激活）。

> ⚠️ **重要**：本插件**只用于"已授权"的安全测试**。不要拿它去做没得到许可的事。
> 详细边界见 `resources/skills/SKILL.md`。

---

## 它有什么用

- **你只管说目标**。比如"测一下这个登录页有没有 SQL 注入"，它会自动排成计划
  （先摸清有哪些入口 → 再验证 → 最后出报告），不用你一步步指挥。
- **不会糊弄你**。它要求证据到位才肯宣布完成，必要的东西没验证完就不会停。
- **敏感信息自动打码**。key、密码之类不会原样写进存档。
- **关掉就回归正常**。不开模式时，你的日常开发请求完全不受影响——插件在提示词里
  渲染出来的是**空字符串**，等于不存在。

## 快速开始

### 装之前要准备什么

只要你**正在正常使用 DeepSeek Harness (DSH)**（能收发消息、能重启会话）就行，
不用再额外装任何东西，也不用改任何配置。

### 怎么安装

在 DSH 会话里发一条命令，把它指向插件文件夹：

```text
dev_install_package C:\repository\dsh-redteam-mode
```

或者用官方的插件管理器（`plugin_manager`，`action: install_bundle`，`target` 填插件目录绝对路径）。

装好后重启会话（或让注入器热加载），你会看到：

- 侧边栏/命令面板里多出 `/redteam` 与 `/opsec` 两个命令；
- 模型多出 `redteam_run` / `redteam_status` / `redteam_evidence` / `redteam_cancel` / `redteam_events` 五个工具；
- 会话预设列表里多出"**红队模式**"。

### 怎么确认装好了（可选的严格校验）

在插件目录里运行（Windows 的 PowerShell / 命令提示符直接跑，不需要 bash）：

```text
node scripts/verify.mjs    装配 + 命令 + 钩子行为（32 项，离线，不需要 DSH 在跑）
node scripts/smoke.mjs     功能回归（解析 / 意图 / 目标 / 控制器 / 运行时）
node scripts/schema.mjs    工具接口格式检查（防官方 API 拒绝 schema）
```

三条都显示"通过"（退出码 0）就算装好了。想更严格，重启一次 DSH，然后：

1. 输入 `/redteam status` → 应返回 `mode=normal ...`；
2. 输入 `/redteam on` → 应返回"红队模式已开启"；
3. 看一眼 `%USERPROFILE%\.dsh\redteam-mode\hook-trace.jsonl` → 应出现 `pre-step`、`command`、`brief-injected` 记录（这就是"钩子真的挂上了"的硬证据）。

### 怎么用

| 你做什么 | 输入 |
|---|---|
| 打开红队模式 | `/redteam on`（轻量）或 `/redteam full`（完全态） |
| 打开并直接给目标 | `/redteam 检查 http://target.local 登录页的 SQL 注入` |
| 只看状态 | `/redteam status` |
| 重置本会话 | `/redteam reset` |
| 用完关掉 | `/redteam off` |
| 调整 OPSEC | `/opsec strict` 或 `/opsec balanced` |

具体怎么走：

1. **打开**：输入 `/redteam on` 或 `/redteam full`。
2. **说目标**：用大白话描述你想测什么，插件会自动开工。
3. **看进度**：随时输入 `redteam_status`，或 `/redteam status`。
4. **关掉**：完事输入 `/redteam off`。

几点放心的地方：

- 平时（没开模式）你的所有请求都**原样处理**，插件不插手：命令面只在你敲斜杠命令时生效，
  钩子每轮都会被调用但立刻放行，提示词段落渲染为空。
- 开着模式时，普通开发请求也**照常**（被识别为 `ordinary-development` 并单独标注）。
- 老的整句写法仍然有效（`开启红队模式`、`/redteam full` 单独一行），
  这是给没有命令界面的环境（headless / 自动化）留的兜底通道。

## 可选的配置（一般不用动）

默认设置开箱即用。下面这几个"环境变量"一般**不用改**：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 插件数据存放的根目录 |
| `DSH_REDTEAM_STATE_DIR` | `$DSH_HOME/redteam-mode/state/` | 每个会话的状态文件放哪 |
| `DSH_REDTEAM_OPS_DIR` | `$DSH_HOME/redteam-mode/operations/` | 任务台账和事件记录放哪 |
| `DSH_REDTEAM_TRACE` | 未设置（=开启） | 设为 `0` 关闭钩子轨迹文件 |

插件行自己的 `config`（写在 `cordis.patch.yml`）也可以调：

| 字段 | 默认 | 作用 |
|---|---|---|
| `role` | `host` | `host`=完整功能（工具/命令/钩子）；`preset`=预设内引导（合同 + 默认模式） |
| `defaultMode` | `normal`（preset 角色下为 `redteam-full`） | 新会话的默认模式 |
| `automationMode` | `active` | `active`=自动派发执行；`plan-only`=只给计划不派发 |
| `injectAuthorizationContext` | `true` | 是否注入授权研究上下文 |
| `injectProfileOnActivation` | `true` | 是否按模型加载 `resources/prompts/` 下的补充档案 |
| `injectPromptSection` | `true` | 是否注册动态提示词段落（关掉=只剩钩子注入） |

## 它是怎么运作的（想弄明白的看）

DSH 2.0 里，插件能插手的地方有三层，本插件三层都用上了：

1. **命令层**：`/redteam` 直接对会话改状态，**不产生模型消息、不花 token**，所以切换是瞬时的。
2. **提示词层**：模式开启时，往系统提示词里塞一份"红队合同"（授权上下文 + 工作流契约 +
   危险边界）。这份合同是**每轮重新求值**的：模式一关，文本变成空串，提示词自动恢复原样。
3. **每轮钩子层**（`agent/pre-step`）：你发一条消息，钩子在模型看到它之前先看一眼。
   如果这算安全任务，就把一份带编号的执行计划**作为你这条消息的一部分**塞进去——
   模型没法跳过自己这一轮的输入。普通开发请求则原样放行。

每一步的产出都被记成证据，最后证据没验收到位就不算完成。

## 技术细节

### 架构映射（Codex 2.1.0 → DSH 2.0）

| Codex 原版机制 | 本插件（DSH 2.0）实现 |
|---|---|
| SessionStart / UserPromptSubmit 外部 hook 进程 | `agent/created` + `agent/pre-step` 瀑布监听（host 层 `{ global: true }`） |
| `model_instructions_file`（写 config.toml 注入系统提示词） | `ctx.systemPrompt.section()` 动态段落，normal 态渲染为空 |
| 斜杠命令由 CLI 解析 | `ctx.commands.register()` 一等命令面（`/redteam`、`/opsec`） |
| 回环改写代理（127.0.0.1:8765） | 当前轮进程内改写（无网络跳数、无伪造历史） |
| stdio MCP runtime 服务 | 原生注册 `redteam_*` 五工具 |
| MCP tools/list 能力发现 | `ctx.tools.get()` / `ctx.tools.execute()` 进程内直调 |
| 预设即模式（旧版 `$DSH_HOME/.agent-presets/<id>/`） | `@deepseek-ai/dsh-agent-preset` 声明行（0.2 新规范，旧的目录扫描已废弃） |

### 双挂载形态

同一个包在 profile 里挂两次，职责不同：

- `role: host`（profile 层）：注册工具、命令、提示词段落，以及 `{ global: true }` 的
  `agent/pre-step` 监听——所以**每个会话**都能用 `/redteam`。
- `role: preset`（红队预设内）：注册提示词合同与一个**不带 `global`** 的监听。
  DSH 的 agent 事件是**按作用域过滤**的，不带 `global` 的监听只对命中该作用域的 agent 生效，
  这正是"选了红队预设的会话自动进入红队模式"的实现方式。

两个实例共享同一份进程内会话缓存与去重集合，所以同一轮绝不会被注入两次。

### 技术栈

- 运行时：DeepSeek Harness 插件体系（Cordis 4 / 事件瀑布）。
- 语言：纯 ESM（`lib/*.mjs` + 入口 `lib/index.js`）——零第三方运行时依赖、无需构建步骤。
- 持久化：JSON 文件 + 追加式 JSONL（Node `fs`）。

### 目录结构

```text
package.json              2.0 bundle 清单（dsh.bundle.patch）
cordis.patch.yml          bundle 补丁：redteam-mode 行 + preset-redteam 预设行
lib/index.js              入口 apply(ctx, config)：三层接线
lib/commands.mjs          /redteam 与 /opsec 命令面
lib/prompt.mjs            动态系统提示词合同（normal 态为空）
lib/hooks.mjs             agent/pre-step 强制钩子 + agent/created
lib/session.mjs           每会话状态缓存 + 落盘
lib/trace.mjs             钩子轨迹（验证用，$DSH_HOME/redteam-mode/hook-trace.jsonl）
lib/parser.mjs            全匹配 模式/OPSEC 命令解析（含文本兜底）
lib/intent.mjs            意图引擎
lib/controller.mjs        每轮处理（调度 / 续跑 / 终局）
lib/profiles.mjs          模型族 → 档案路由
lib/runtime/*.mjs         目标编译 / 工作流 / 台账 / 工具调用 / 证据 / 判定 / 操作
resources/                指令契约 + 越狱档案 + 边界策略
scripts/verify.mjs        装配与行为验证（32 项，离线）
scripts/smoke.mjs         功能回归
scripts/schema.mjs        工具 schema 合规断言
docs/                     移植设计与验证说明
```

## 用途边界

- 仅限**已授权**的安全评估。
- 不可逆的操作，仍会要求你**明确确认**后才执行。

## 许可证

本项目使用 [MIT](LICENSE) 协议。
