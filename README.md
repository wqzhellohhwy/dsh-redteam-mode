# dsh-redteam-mode

给 **DeepSeek Harness (DSH)** 加一个"红队模式"开关的插件。

打开后，你用大白话描述一个安全测试目标，它会自动把目标拆成一步一步的计划并执行，
每步都记录证据；做完后一键关掉，一切恢复正常。

> ⚠️ **重要**：本插件**只用于"已授权"的安全测试**。不要拿它去做没得到许可的事。
> 详细边界见 `resources/skills/SKILL.md`。

---

## 它有什么用

- **你只管说目标**。比如"测一下这个登录页有没有 SQL 注入"，它会自动排成计划
  （先摸清有哪些入口 → 再验证 → 最后出报告），不用你一步步指挥。
- **不会糊弄你**。它要求证据到位才肯宣布完成，必要的东西没验证完就不会停。
- **敏感信息自动打码**。key、密码之类不会原样写进存档。
- **关掉就回归正常**。不开模式时，你的日常开发请求完全不受影响。

## 快速开始

### 装之前要准备什么

只要你**正在正常使用 DeepSeek Harness (DSH)**（能收发消息、能重启会话）就行，
不用再额外装任何东西，也不用改任何配置。

### 怎么安装

就一步：

1. 把整个插件文件夹放到你电脑的任意位置（比如桌面）。
2. 打开 DSH 会话，发送下面这条命令，并把它指向刚才那个插件文件夹：

   ```
   dev_install_package 目标/路径插件文件夹所在位置
   ```

3. 按提示重启会话。

装好之后，你能输入`/redteam light`或`/redteam on` 并看到"已开启红队模式"的提示，就说明装好了。

### 怎么确认装好了（可选校验）

如果想更严格地确认，可以在插件文件夹目录里打开 PowerShell / 命令提示符，运行：

```text
node scripts/smoke.mjs   功能回归检查
node scripts/schema.mjs  工具接口格式检查
```

两条命令都显示"通过"（退出码 0），就说明装好了。

说明：

- 这两条**不需要 bash**，Windows 的 PowerShell / 命令提示符里直接运行即可。
- 需要电脑装有 Node.js（用 DSH 一般已自带）。
- 不想跑校验也没关系：能正常输入`/redteam light`并得到开启提示，就算装好了。

### 怎么用

只需记住四件事：

| 你做什么 | 输入 |
|---|---|
| 打开红队模式 | `/redteam light`或`/redteam on`（要完全态就用 `/redteam full`） |
| 描述你的目标 | 用大白话直接说，比如"检查 http://target.local 的登录页有没有 SQL 注入，并给出 PoC" |
| 看进度 | `redteam_status` |
| 用完关掉 | `/redteam off` |

具体怎么走：

1. **打开**：输入`/redteam light`或`/redteam on`。
2. **说目标**：用大白话描述你想测什么，插件会自动开工。
3. **看进度**：随时输入`redteam_status`。
4. **关掉**：完事输入`/redteam off`。

几点放心的地方：

- 平时（没开模式）你的所有请求都**原样处理**，插件不插手。
- 开着模式时，普通开发请求也**照常**；只有安全类的请求才会被额外编排。
- 命令是**整句精确匹配**的，日常随口提到"redteam"也不会误开模式。

## 可选的配置（一般不用动）

默认设置开箱即用。下面这几个"环境变量"一般**不用改**，只有特殊需要才动：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | 插件数据存放的根目录 |
| `DSH_REDTEAM_STATE_DIR` | `$DSH_HOME/redteam-mode/state/` | 每个会话的状态文件放哪 |
| `DSH_REDTEAM_OPS_DIR` | `$DSH_HOME/redteam-mode/operations/` | 任务台账和事件记录放哪 |

想改的人，在启动 DSH 前设置对应变量即可；不想管的，忽略这节就行。

## 它是怎么运作的（想弄明白的看）

它靠"**先拦一下、再当场塞计划**"的方式工作：你一发消息，它先判断这算不算安全目标；
如果是，就当场把一份带编号的执行计划作为"输入"喂给模型，模型想跳过这一轮都不行；
每一步的产出都被记成证据，最后证据没验收到位就不算完成。

## 技术细节

### 架构映射（Codex → DSH）

本插件是把原版 `codex-redteam-mode` 移植到 DSH 的实现，两者能力对等：

| Codex 原版机制 | 本插件（DSH）实现 |
|---|---|
| SessionStart / UserPromptSubmit 外部 hook 进程 | `agent/session-start` + `agent/pre-step` 瀑布监听 |
| `model_instructions_file`（写 config.toml 注入系统提示词） | 模式切换时注入一条持久 activation 消息 |
| 回环改写代理（127.0.0.1:8765） | 当前轮进程内改写（无网络跳数） |
| stdio MCP runtime 服务 | 原生注册 `redteam_*` 工具 |
| MCP tools/list 能力发现 | `ctx.tools.get()` / `ctx.tools.execute()` 进程内直调 |

### 技术栈

- 运行时：DeepSeek Harness 插件体系（Cordis / 事件瀑布）。
- 语言：纯 ESM（`lib/*.mjs`）——零第三方运行时依赖、无需构建步骤。
- 持久化：JSON 文件 + 追加式 JSONL（Node `fs`）。

### 目录结构

```text
lib/index.mjs             入口：事件接线 + 工具注册
lib/parser.mjs            全匹配 模式/OPSEC 命令解析
lib/intent.mjs            意图引擎
lib/state.mjs             每会话状态机 + 持久化
lib/controller.mjs        每轮处理（调度 / 续跑 / 终局）
lib/profiles.mjs          模型族 → 档案路由
lib/runtime/*.mjs         目标编译 / 工作流 / 台账 / 工具调用 / 证据 / 判定 / 操作
resources/                指令契约 + 越狱档案 + 边界策略
scripts/                  校验脚本
docs/                     移植设计说明
```

## 用途边界

- 仅限**已授权**的安全评估。
- 不可逆的操作，仍会要求你**明确确认**后才执行。

## 许可证

本项目使用 [MIT](LICENSE) 协议。
