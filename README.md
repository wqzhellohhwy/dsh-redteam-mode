# dsh-redteam-mode

**Hook-enforced red-team mode for DeepSeek Harness (DSH).**

A native DSH plugin that ports the architecture of
[codex-redteam-mode](https://github.com/chAng-L19/codex-redteam-mode) into the
DeepSeek Harness plugin system — replacing Codex's external hook processes, a
loopback rewrite proxy, and a stdio MCP server with in-process DSH
primitives, while keeping the same *structural enforcement* semantics.

> ⚠️ **Intended use**: authorized security assessment workflows only. See
> [Usage boundaries](#usage-boundaries) and `resources/skills/SKILL.md`.

---

## Why

A one-line system prompt is not enough to keep a capable model from refusing
mid-task or drifting out of scope. This plugin applies **three layers of
structural enforcement** and a **durable, evidence-driven operation runtime**:

1. **Full-match mode switching** — commands like `/redteam full` only fire on an
   exact whole-message match; look-alike phrases never misfire.
2. **Turn-level anchoring** — under an active mode, security intents are
   compiled into a numbered-Clause *Research Brief* and injected into the model's
   *own* current turn as a user-role message it cannot skip.
3. **Compiled targets + redaction** — URLs / IPs / hosts / paths are extracted as
   targets; secrets (keys/tokens/passwords) are redacted before entering the
   contract.

On top of that a persistent **operation runtime** executes the
`generic-adaptive` workflow with a TerminalJudge gate: the task cannot be
reported done until required artifacts are verified.

## Features

- 🎯 **Full-match command parsing** — `/redteam full|light|on|off`, `开启/退出红队模式`,
  `/opsec strict|balanced`. `normal` mode is zero-interference.
- 🧠 **Intent engine** — scene / risk / taxonomy classification + Clause
  compilation for every security turn under an active mode.
- 🔒 **Secret redaction** — sensitive values are stripped from the stored
  contract.
- ⚙️ **generic-adaptive workflow** — map-surface → build-hypotheses →
  validate-path → prove-impact → review-coverage → cleanup → report.
- 🧾 **Evidence graph + semantic gate** — artifacts tracked with lineage; a
  model-assisted TerminalJudge (falling back to heuristics) blocks premature
  completion.
- 💾 **Durable, session-isolated state** — per-session JSON under `$DSH_HOME`,
  resumable across restarts; parallel sessions never share state.
- 🧰 **Native tool surface** — `redteam_run / status / evidence / cancel / events`
  registered as first-class DSH tools (no MCP server required).

## Tech stack

- **Runtime**: DeepSeek Harness plugin system (Cordis / event waterfall).
- **Language**: plain ESM (`lib/*.mjs`) — **zero third-party runtime
  dependencies**, no build step.
- **Persistence**: JSON files + append-only JSONL via Node `fs`.

## Architecture mapping (Codex → DSH)

| Codex mechanism | DSH implementation |
|---|---|
| SessionStart / UserPromptSubmit external hook process | `agent/session-start` + `agent/pre-step` waterfall listeners |
| `model_instructions_file` (config.toml) | persistent activation message on mode switch |
| Loopback rewrite proxy (127.0.0.1:8765) | in-process pre-step rewrite of the current turn |
| stdio MCP runtime server | native `redteam_*` tools |
| MCP tools/list discovery | `ctx.tools.get()` / `ctx.tools.execute()` direct calls |

See [`docs/PORT-DESIGN.md`](docs/PORT-DESIGN.md) for the full design notes.

## Quick start

### Prerequisites

- DeepSeek Harness (DSH) running with the **web profile** and agent-loop
  (all standard bundles enabled). The plugin needs `tools`, `agent`, and
  `system-prompt` bundles — all present by default.
- Node.js (the DSH host runtime).

### Install

1. Clone the repo anywhere, e.g.:

   ```bash
   git clone https://github.com/<your-github>/dsh-redteam-mode.git
   ```

2. From a **shell-capable DSH session**, install the plugin into your current
   profile:

   ```
   dev_install_package   (target: this repo)
   ```

   — or, if you manage profiles by hand, place/link the package into your
   profile's `node_modules/@dsh-external/` and activate it via the plugin
   bundle layer (see `cordis.patch.yml`).

3. Restart the DSH session (or use the plugin hot-reload) and confirm the
   loader shows the plugin as **active**.

> **Portability**: no code path is hard-coded to any machine. Runtime state
> lives under `$DSH_HOME/redteam-mode/`. You can override the locations with
> `DSH_REDTEAM_STATE_DIR` / `DSH_REDTEAM_OPS_DIR` (see
> [Configuration](#configuration)).

### Verify the install

```bash
bash scripts/build.sh    # zero-build validation (syntax + entry import + resources)
node scripts/smoke.mjs   # 22 known-answer regression checks
node scripts/schema.mjs  # tool JSON-Schema projection assertions
```

All three should exit `0`.

## Usage

```
/redteam light          # enter red-team mode (light)
/redteam full           # full mode
/opsec strict           # tighten OPSEC
<security objective>    # auto-compiled into a Research Brief and dispatched
redteam_run {objective} # explicit start/advance (or let the model call it)
redteam_status / redteam_evidence / redteam_events / redteam_cancel
/redteam off            # exit, restore normal engineering behavior
```

- **normal mode** passes every turn through untouched.
- Under an active mode, ordinary development turns still pass through clean;
  only security-intent turns get the compiled Brief + dispatch overlay.

## Configuration

The plugin reads the following environment variables (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `DSH_HOME` | `~/.dsh` | DSH root used to derive state paths |
| `DSH_REDTEAM_STATE_DIR` | `$DSH_HOME/redteam-mode/state/` | Per-session state JSON |
| `DSH_REDTEAM_OPS_DIR` | `$DSH_HOME/redteam-mode/operations/` | Operation ledgers + events |

No other configuration is required. Model-prompt profiles (e.g.
`Jailbreak.gpt-5.6.md`) live under `resources/prompts/` and are routed by
model family via `lib/profiles.mjs` — extend the table to add a new family.

## Development

```bash
node --check lib/index.mjs     # any changed module
bash scripts/build.sh          # full zero-build validation
node scripts/smoke.mjs         # functional regression
node scripts/schema.mjs        # tool schema projection guard
```

To validate, commit, create the public GitHub repo, and push in one go:

```bash
bash scripts/publish.sh        # needs gh CLI authenticated; see REPO_NAME/REPO_DESC env
```

Layout:

```
lib/index.mjs              plugin entry: event wiring + tool registration
lib/parser.mjs             mode/opsec command parsing (full-match semantics)
lib/intent.mjs             intent engine: scene/risk/taxonomy/Clause compiler
lib/state.mjs              per-session state machine + JSON persistence
lib/controller.mjs         process_turn (dispatch/resume/terminal routing)
lib/profiles.mjs           model-family → supplemental profile routing
lib/runtime/*.mjs          goal compiler / workflow / store / broker / evidence / judge / operations
resources/                 instruction.ctf.md + Jailbreak.*.md + boundary policy (original assets)
scripts/                   build validation + smoke + schema guards
docs/                      port design notes (knowledge base)
```

Contributions should follow the portability rules in
`docs/PORT-DESIGN.md` (§6): no absolute paths, no machine-specific values,
no committing runtime state.

## Usage boundaries

This plugin inherits the original project's MIT license and **intended-use
boundary: authorized security assessment only**. `resources/skills/SKILL.md`
(redteam-boundary-policy) defines the operational boundary; irreversible
actions still require explicit confirmation (authorized-research-context §5).

## License

[MIT](LICENSE) © dsh-redteam-mode contributors.

---

# 中文说明

**dsh-redteam-mode**：把 [codex-redteam-mode](https://github.com/chAng-L19/codex-redteam-mode)
的"钩子强制 + 意图编译 + 持久化运行时"红队模式架构，原生移植进 **DeepSeek Harness (DSH)**
插件体系。用进程内 DSH 原语替换了原版的外部 hook 进程、回环改写代理与 stdio MCP
服务，同时保留同等的结构性强制语义。

**使用前提**：仅限**已授权**的安全评估工作流（操作边界见 `resources/skills/SKILL.md`）。

**快速开始**
```bash
git clone https://github.com/<your-github>/dsh-redteam-mode.git
# 在可执行 shell 的 DSH 会话里：
dev_install_package   # 目标指向本仓库
# 校验
bash scripts/build.sh && node scripts/smoke.mjs && node scripts/schema.mjs
```

**常用命令**
```
/redteam light | full      # 进入红队模式
/opsec strict              # 收紧 OPSEC
<安全目标描述>              # 自动编译为 Research Brief 并调度
redteam_run / status / evidence / events / cancel
/redteam off               # 退出，恢复正常工程行为
```

**可移植性**：代码零本机硬编码路径；运行时数据存于 `$DSH_HOME/redteam-mode/`
（可用 `DSH_REDTEAM_STATE_DIR` / `DSH_REDTEAM_OPS_DIR` 覆盖）。

**技术栈**：纯 ESM、零第三方运行时依赖、无构建步骤；状态/台账用 JSON + JSONL 持久化。

详细设计见 [`docs/PORT-DESIGN.md`](docs/PORT-DESIGN.md)，MIT 协议。
