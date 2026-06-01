/**
 * Workflow 类型定义
 *
 * 见 dev-plans/workflow-feature.md §3（定义格式）/ §4.1（统一 Step 契约）/ §5（run 记录）。
 *
 * 两类对象：
 *   - 定义（WorkflowDef / WorkflowStep ...）：声明式数据，来自 ${HOME}/workflows/<name>.md 的 frontmatter。
 *   - 运行（WorkflowRun / StepRun ...）：一次执行的状态，持久化到 workflow-runs.json。
 */

// ============================================================
// 定义（声明式，来自 .md frontmatter）
// ============================================================

export type StepKind = 'agent' | 'script';

/** run 级输入参数声明 */
export interface WorkflowInput {
  name: string;
  required?: boolean;
  default?: string;
  description?: string;
}

/** observe 的展示档：inline=挂节点的 markdown / artifact=走 Workbench viewer */
export type ObserveAs = 'inline' | 'artifact';

/** observe 来源：result=用 step 的 result / { file } = 读 run workspace 内某文件 */
export type ObserveFrom = 'result' | { file: string };

/** 可选的「人看」中间输出声明（纯观测，不参与 DAG/数据流） */
export interface ObserveSpec {
  label: string;
  from: ObserveFrom;
  as: ObserveAs;
}

/** 一个 workflow 步骤（DAG 节点） */
export interface WorkflowStep {
  id: string;
  kind: StepKind;
  /** 依赖的上游 step id；空 = 入口节点 */
  dependsOn?: string[];
  /** 超时（秒）。agent 默认 600，script 默认 600。 */
  timeout?: number;
  /** step 级规则/约束（→ customRules，仅 agent step） */
  guidance?: string;
  observe?: ObserveSpec;

  // kind: agent
  /** persona 名（→ PersonaRegistry.get） */
  persona?: string;
  /** 本次任务 prompt（→ processUserInput），支持 {{}} 插值 */
  prompt?: string;

  // kind: script
  /** 内联 shell 命令；与 scriptFile 二选一 */
  run?: string;
  /** 脚本文件路径（相对 workflow 定义目录或绝对）；与 run 二选一 */
  scriptFile?: string;
}

/** 一个 workflow 定义 */
export interface WorkflowDef {
  name: string;
  description?: string;
  version?: string;
  inputs?: WorkflowInput[];
  /** workflow 级规则/约束，应用到所有 agent step（与 step.guidance 拼接） */
  guidance?: string;
  steps: WorkflowStep[];
  /** 定义文件绝对路径 */
  filePath: string;
  /** 来源层：'user' | 'project' | 'marketplace:<name>'（MVP 仅 user/project） */
  source: string;
}

// ============================================================
// 运行（状态，持久化）
// ============================================================

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type RunStatus = 'running' | 'done' | 'partial-failed' | 'cancelled' | 'interrupted';

/** observe 的实际产出（捕获后存进 run 记录，推给 UI） */
export interface ObserveOutput {
  label: string;
  as: ObserveAs;
  /** inline：markdown 文本；artifact：留空，用 artifactPath 引用 */
  content?: string;
  /** artifact：run workspace 内的文件绝对路径 */
  artifactPath?: string;
}

/** 单个 step 的运行状态 */
export interface StepRun {
  id: string;
  kind: StepKind;
  /** agent step 的人设名（快照：历史可见那次用了哪个 persona） */
  persona?: string;
  /** 依赖快照（建 run 时从 def 拷入，使 run 记录自包含——前端画图/历史无需再查 def） */
  dependsOn?: string[];
  status: StepStatus;
  /** agent=最终消息 / script=stdout */
  result: string;
  error?: string;
  observe?: ObserveOutput;
  /** 渲染后的 guidance 快照（历史回看用） */
  guidanceSnapshot?: string;
  startedAt?: string;
  completedAt?: string;
}

/** 一次 workflow 运行 */
export interface WorkflowRun {
  id: string;
  workflowName: string;
  inputs: Record<string, string>;
  status: RunStatus;
  /** 本次 run 的共享 workspace 目录 */
  runDir: string;
  steps: StepRun[];
  /** 触发来源：cli / schedule / ui:<jid> */
  trigger?: string;
  createdAt: string;
  completedAt?: string;
}

// ============================================================
// 执行期上下文（传给 template / stepRunners）
// ============================================================

/** 渲染 {{}} 时可见的数据：inputs + 已完成 step 的 result */
export interface RenderContext {
  inputs: Record<string, string>;
  /** stepId → result（仅已完成的 step） */
  stepResults: Record<string, string>;
  runDir: string;
}
