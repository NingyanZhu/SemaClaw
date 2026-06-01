---
name: workflow
description: Author and run reusable multi-step workflows — fan out parallel agent (persona) tasks plus deterministic script steps as a saved, parameterized routine. Use when the user wants to codify a repeatable routine ("每次都…") instead of re-typing orchestration each time.
version: 1.0.0
---

# Reusable Workflows

A **workflow** is a saved, parameterized DAG of steps that runs as a fixed routine. Use it when the user has a *repeatable* routine (e.g. "每周竞品调研：N 个角度并行调研，再汇总成报告") that they'd otherwise re-describe every time. For one-off creative orchestration, just dispatch directly — don't make a workflow.

Each step is either an **agent** step (an isolated persona doing judgement work) or a **script** step (deterministic shell: fetch/transform/file ops). Steps form a DAG via `dependsOn`. The executor only spawns isolated sessions — it never touches live group agents.

## Where definitions live

User workflow definitions are Markdown files with YAML frontmatter at:

```
~/semaclaw/workflows/<name>.md          # (override: $SEMACLAW_WORKFLOWS_DIR)
```

Your job (the agent) is usually to **author / edit the `.md` definition** when the user describes a routine. Running is normally done by the user via CLI or the UI; you may run it for them when asked.

## Definition format example

```yaml
---
name: market-research                 # unique; falls back to filename
description: 多角度并行调研 + 汇总报告
version: 1.0.0
inputs:                               # run-time parameters
  - { name: topic, required: true }
  - { name: depth, default: "standard" }
guidance: |                           # workflow-level rules, applied to ALL agent steps
  全程用中文；回答精炼，给依据。
steps:
  - id: research_tech                 # unique id; referenced by {{steps.research_tech.result}}
    kind: agent
    persona: researcher               # must exist in ~/semaclaw/virtual-agents/researcher.md
    prompt: |
      就「{{input.topic}}」从技术角度调研，深度 {{input.depth}}。
    guidance: |                       # step-level rules (merged after workflow guidance)
      只看近 2 年；输出分「成熟度/风险/趋势」三段；不要市场数据。
    timeout: 300                      # seconds (default 600)
    observe: { label: "技术调研", from: result, as: inline }

  - id: research_market
    kind: agent
    persona: researcher
    prompt: "就「{{input.topic}}」从市场角度调研。"

  - id: fetch_metrics
    kind: script
    run: |                            # 用系统已装工具（cwd=本 run 的空目录，但 PATH/工具都在）
      curl -s "https://api.example.com/price?q=$WF_INPUT_TOPIC" > "$WF_RUN_DIR/metrics.json"
      echo fetched
    observe: { label: "原始指标", from: { file: metrics.json }, as: artifact }

  - id: summary
    kind: agent
    persona: analyst
    dependsOn: [research_tech, research_market, fetch_metrics]
    prompt: |
      汇总成报告：
      技术：{{steps.research_tech.result}}
      市场：{{steps.research_market.result}}
      指标见 run workspace 内 metrics.json。
    observe: { label: "最终报告", from: result, as: inline }
---
（可选正文：给人读的 workflow 说明）
```

### Step fields

| field | applies to | meaning |
|---|---|---|
| `id` | all | unique; downstream refer via `{{steps.<id>.result}}` |
| `kind` | all | `agent` \| `script` |
| `dependsOn` | all | upstream step ids; empty = entry node. **Auto-inferred** from data refs (see below) — only needed for ordering-only deps with no data ref |
| `timeout` | all | seconds (default 600) |
| `observe` | all | optional human-facing output (see below) |
| `persona` | agent | persona name in `~/semaclaw/virtual-agents/` — **must exist** |
| `prompt` | agent | the task; supports `{{}}` |
| `guidance` | agent | rules/constraints; supports `{{}}` |
| `run` | script | inline shell command |
| `scriptFile` | script | path to a script (relative to the def file or absolute; must be executable) |

## How data flows between steps

Two channels:

1. **`result` string** — every step produces a `result` (agent = final message, script = stdout). Reference it downstream with `{{steps.<id>.result}}`.
2. **Shared run workspace** — one dir per run; both agent (`workingDir`) and script (`cwd`) point at it. Pass real files/data here (script writes `data.csv` → agent reads it).

**Templating** (agent `prompt` / `guidance`): `{{input.<name>}}` and `{{steps.<id>.result}}` — plain substitution, no logic.

**Data refs auto-create dependencies.** Referencing a step's result — `{{steps.X.result}}` in a prompt/guidance, or `$WF_STEP_X_RESULT` in an inline `run` — automatically adds `X` to that step's `dependsOn` (union with whatever you declared). So a ref and its dependency can never drift out of sync, and you rarely need to write `dependsOn` by hand. Caveats: referencing a non-existent step is a load error (fails loud, not a silent empty); `scriptFile` bodies aren't scanned, so declare their `dependsOn` explicitly; `{{steps.*}}` is **not** allowed in workflow-level `guidance` (it applies to every agent step).

**Script env vars** (scripts don't get `{{}}` — they read env, safer):
- `WF_INPUT_<NAME>` — each run input (name upper-cased)
- `WF_STEP_<ID>_RESULT` — each completed upstream step's result
- `WF_RUN_DIR` — this run's workspace (**fresh & empty every run** — see below)
- `WF_WORKFLOW_DIR` — this workflow's **persistent** dir (survives across runs)
- `WF_OBSERVE_DIR` — observe scratch dir

## Working directory & files (important)

Every step's **cwd is `WF_RUN_DIR`**, which is **brand-new and empty on each run** (`~/semaclaw/workflow-runs/<runId>/`). Implications — read these before writing scripts:

- **It is NOT a sandbox.** The host environment is inherited: `PATH`, system `python3`/`node`/`curl`, and anything already installed all work. The *only* thing that's empty is the cwd's files. "No environment" is almost never the real problem — missing *files* is.
- **To read the user's files** (a PDF, a repo, a CSV): **pass an absolute path as an input** and read from it directly — do NOT assume the file is in cwd. e.g. `inputs: [{ name: paper_path, required: true }]` then in the script read `"$WF_INPUT_PAPER_PATH"`.
- **Transient / inter-step data** → write under `WF_RUN_DIR` (gone after the run; perfect for passing between steps).
- **Persistent things** (a venv, a cache, an output file that accumulates across runs) → use `WF_WORKFLOW_DIR`. Build heavy environments **once, idempotently**:
  ```bash
  [ -d "$WF_WORKFLOW_DIR/venv" ] || python3 -m venv "$WF_WORKFLOW_DIR/venv"
  "$WF_WORKFLOW_DIR/venv/bin/pip" install -q -r requirements.txt
  ```
  Don't reinstall environments every run. (caveat: two concurrent runs of the same workflow share `WF_WORKFLOW_DIR` — avoid clobbering the same file.)

## Agent steps = three layers (don't conflate)

| layer | source | role |
|---|---|---|
| identity | `persona` (its systemPrompt) | who the agent is |
| **rules** | **`guidance`** (workflow + step, merged) | how/constraints — the layer to tune |
| task | `prompt` | what to do this run (varies with inputs) |

**When authoring, infer a sensible `guidance` for each agent step** (output format, scope limits, tone) — that's the field the user will most want to tweak. Keep `prompt` as the parameterized task, `guidance` as the stable rules.

## observe (optional human-facing output)

Pure observation — does NOT affect the DAG. Two forms:
- `as: inline` → short markdown shown on the node (`from: result` or `from: { file }`).
- `as: artifact` → a richer file (HTML/report) shown in the Workbench (`from: { file: report.html }`).

Omit `observe` and the step just shows status. Use it on the steps whose output a human wants to glance at.

## Common pattern: fan-out → aggregate

"N 个 persona 并行 → 1 个汇总" = **N sibling agent steps (no deps) + 1 aggregator step with `dependsOn: [all N]`**. No special syntax needed (see `market-research` above). Parallelism is automatic, capped at 5 concurrent steps per run.

## Authoring (write the definition)

Write the `.md` to the workflows dir. Either use the Write tool, or heredoc:

```bash
mkdir -p ~/semaclaw/workflows
cat > ~/semaclaw/workflows/daily-digest.md <<'WF_EOF'
---
name: daily-digest
description: 抓取 + 摘要
inputs:
  - { name: feed_url, required: true }
steps:
  - id: fetch
    kind: script
    run: |
      curl -s "$WF_INPUT_FEED_URL" > "$WF_RUN_DIR/raw.txt"
      wc -l < "$WF_RUN_DIR/raw.txt"
  - id: digest
    kind: agent
    persona: summarizer
    dependsOn: [fetch]
    prompt: "把 raw.txt（{{steps.fetch.result}} 行）总结成 5 条要点。"
    guidance: "中文，每条一句话。"
    observe: { label: "摘要", from: result, as: inline }
---
WF_EOF
```

## Running & listing

```bash
semaclaw workflow list                                    # 列出可用 workflow
semaclaw workflow run market-research -i topic=本地大模型 -i depth=deep
semaclaw workflow run market-research -i topic=X --json    # 完整 run 记录 JSON
```

`run` 跑通后会打印每个 step 的状态、result 预览、observe，并在 `~/semaclaw/workflow-runs/<runId>/` 留下该次 run 的 workspace。

## Constraints & gotchas

- **agent step 的 `persona` 必须已存在**于 `~/semaclaw/virtual-agents/`，否则该 step 直接 failed。先确认/创建 persona。
- **`dependsOn` 只能引用已存在的 step id，且不能成环**（校验不过会被跳过加载）；引用某 step 的 result 会自动并入它的 dependsOn，引用不存在的 step 会报错。
- **script 只做确定性活**（取数/转换/文件/调外部 API）；不要在 script 里偷偷起 agent——要 agent 就用 agent step（否则不计入并发、UI 看不到）。
- **失败会级联**：某 step 失败 → 依赖它的下游被跳过 → 整个 run 标 `partial-failed`。
- 静态 fan-out（固定 N 个）现已支持；**动态 fan-out**（数量由上游产出决定）、审批闸、条件分支尚未支持。
- 改了定义文件即时生效（registry 热重载），不用重启。
- **重启会中断在跑的 run**：daemon 重启时,上次还在 `running` 的 run 会被对账为 `interrupted`（其在跑 step→failed、未跑 step→skipped）。run 不会自动续跑,需重新触发。
