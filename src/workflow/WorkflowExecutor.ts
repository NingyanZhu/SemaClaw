/**
 * WorkflowExecutor — DAG 调度引擎
 *
 * 见 dev-plans/workflow-feature.md §4。
 *
 * 完全独立：只通过 stepRunners 起隔离 session（agent）或 child_process（script），
 * 不碰 AgentPool / DispatchBridge / 持久化 agent。
 *
 * 两种调用：
 *   - `run(def, inputs)`：await 到结束，返回最终 run（CLI 用）。
 *   - `start(def, inputs)`：同步返回 { run, done }，run 立刻带 runId，后台异步推进（daemon 用，配 onUpdate 推 WS）。
 *   - `cancel(runId)`：最简取消——停止派发新 step，标 cancelled；在跑的 step 自然跑完（不中途强杀）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { PersonaConfig } from '../agent/PersonaRegistry';
import type {
  WorkflowDef, WorkflowRun, StepRun, RenderContext, ObserveOutput, ObserveSpec,
} from './types';
import { WorkflowRunStore } from './runStore';
import { runAgentStep, runScriptStep, type StepRunResult } from './stepRunners';
import { buildSkillsExtraDirs } from './skillsDirs';

const DEFAULT_CONCURRENCY = 5;

export interface WorkflowExecutorOpts {
  store: WorkflowRunStore;
  /** persona 查询（CLI 传 registry.get.bind(registry)） */
  getPersona: (name: string) => PersonaConfig | null;
  /** per-run 并发上限，默认 5 */
  concurrency?: number;
  /** 每次状态变化回调（持久化之后），daemon 用来推 WS */
  onUpdate?: (run: WorkflowRun) => void;
  /** workflow 持久目录根（每 workflow 一个子目录 → WF_WORKFLOW_DIR）；不传则不注入该变量 */
  workflowDataDir?: string;
}

const TERMINAL: ReadonlySet<StepRun['status']> = new Set(['done', 'failed', 'skipped']);

interface RunControl {
  cancelled: boolean;
}

export class WorkflowExecutor {
  private readonly store: WorkflowRunStore;
  private readonly getPersona: (name: string) => PersonaConfig | null;
  private readonly concurrency: number;
  private readonly onUpdate?: (run: WorkflowRun) => void;
  private readonly workflowDataDir?: string;
  /** 在跑的 run：runId → control，供 cancel 用 */
  private readonly activeRuns = new Map<string, RunControl>();

  constructor(opts: WorkflowExecutorOpts) {
    this.store = opts.store;
    this.getPersona = opts.getPersona;
    this.concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;
    this.onUpdate = opts.onUpdate;
    this.workflowDataDir = opts.workflowDataDir;
  }

  /** await 到结束（CLI 用） */
  async run(def: WorkflowDef, provided: Record<string, string> = {}, trigger?: string): Promise<WorkflowRun> {
    return this.start(def, provided, trigger).done;
  }

  /**
   * 同步起一次 run：立刻返回带 runId 的 run + 完成 Promise。后台异步推进。
   * @throws 若缺少 required input（同步抛，调用方处理）
   */
  start(
    def: WorkflowDef,
    provided: Record<string, string> = {},
    trigger?: string,
  ): { run: WorkflowRun; done: Promise<WorkflowRun> } {
    const inputs = this.resolveInputs(def, provided);
    const run = this.store.newRun(def.name, inputs, trigger);
    run.steps = def.steps.map<StepRun>(s => ({
      id: s.id,
      kind: s.kind,
      persona: s.persona,
      dependsOn: s.dependsOn,
      status: 'pending',
      result: '',
    }));
    this.emit(run);

    const control: RunControl = { cancelled: false };
    this.activeRuns.set(run.id, control);
    const done = this.execute(run, def, inputs, control);
    return { run, done };
  }

  /** 最简取消：停止派发新 step + 标记，已在跑的自然跑完 */
  cancel(runId: string): boolean {
    const control = this.activeRuns.get(runId);
    if (!control) return false;
    control.cancelled = true;
    return true;
  }

  isRunning(runId: string): boolean {
    return this.activeRuns.has(runId);
  }

  // ===== Internal =====

  private execute(
    run: WorkflowRun,
    def: WorkflowDef,
    inputs: Record<string, string>,
    control: RunControl,
  ): Promise<WorkflowRun> {
    const observeDir = path.join(run.runDir, '.observe');
    const stepRunById = new Map(run.steps.map(sr => [sr.id, sr]));
    const stepDefById = new Map(def.steps.map(d => [d.id, d]));
    const stepResults: Record<string, string> = {};

    return new Promise<WorkflowRun>((resolve) => {
      let active = 0;
      let finished = false;

      const depsDone = (id: string): boolean =>
        (stepDefById.get(id)?.dependsOn ?? []).every(d => stepRunById.get(d)?.status === 'done');

      const depsFailedOrSkipped = (id: string): boolean =>
        (stepDefById.get(id)?.dependsOn ?? []).some(d => {
          const st = stepRunById.get(d)?.status;
          return st === 'failed' || st === 'skipped';
        });

      const finalize = (): void => {
        if (finished) return;
        finished = true;
        if (control.cancelled) {
          for (const sr of run.steps) {
            if (sr.status === 'pending') { sr.status = 'skipped'; sr.completedAt = now(); }
          }
          run.status = 'cancelled';
        } else {
          const anyBad = run.steps.some(s => s.status === 'failed' || s.status === 'skipped');
          run.status = anyBad ? 'partial-failed' : 'done';
        }
        run.completedAt = now();
        this.activeRuns.delete(run.id);
        // 没写任何文件的 run（纯 agent 推理 / echo 类）不留空目录；取消的 run 可能还有在跑的
        // step 在写盘，跳过清理以免拔掉它脚下的 cwd。
        if (!control.cancelled) cleanupEmptyRunDir(run.runDir);
        this.emit(run);
        resolve(run);
      };

      const pump = (): void => {
        if (finished) return;

        // 1. 上游失败/跳过 → 级联跳过
        for (const sr of run.steps) {
          if (sr.status === 'pending' && depsFailedOrSkipped(sr.id)) {
            sr.status = 'skipped';
            sr.completedAt = now();
          }
        }

        // 2. 未取消时，在 cap 内派发就绪 step
        while (!control.cancelled && active < this.concurrency) {
          const sr = run.steps.find(s => s.status === 'pending' && depsDone(s.id));
          if (!sr) break;
          const stepDef = stepDefById.get(sr.id)!;
          sr.status = 'running';
          sr.startedAt = now();
          this.emit(run);

          const ctx: RenderContext = { inputs, stepResults: { ...stepResults }, runDir: run.runDir };

          active++;
          this.executeStep(stepDef, def, ctx, observeDir)
            .then((res) => {
              this.applyResult(sr, stepDef.observe, res, run.runDir);
              if (sr.status === 'done') stepResults[sr.id] = sr.result;
            })
            .catch((e: unknown) => {
              sr.status = 'failed';
              sr.error = e instanceof Error ? e.message : String(e);
              sr.completedAt = now();
            })
            .finally(() => {
              active--;
              this.emit(run);
              pump();
            });
        }

        // 3. 终止：无在跑 step，且（全终态 或 已取消）
        if (active === 0) {
          const allTerminal = run.steps.every(sr => TERMINAL.has(sr.status));
          if (allTerminal || control.cancelled) finalize();
        }
      };

      pump();
    });
  }

  private async executeStep(
    stepDef: WorkflowDef['steps'][number],
    def: WorkflowDef,
    ctx: RenderContext,
    observeDir: string,
  ): Promise<StepRunResult> {
    if (stepDef.kind === 'agent') {
      if (!stepDef.persona) {
        return { result: '', failed: true, error: `agent step "${stepDef.id}" missing persona` };
      }
      const persona = this.getPersona(stepDef.persona);
      if (!persona) {
        return { result: '', failed: true, error: `persona "${stepDef.persona}" not found` };
      }
      return runAgentStep(stepDef, persona, def, ctx, {
        skillsExtraDirs: buildSkillsExtraDirs(ctx.runDir),
      });
    }
    // script：注入持久目录 WF_WORKFLOW_DIR（按 workflow 名，跨 run 保留），懒创建
    let workflowDir: string | undefined;
    if (this.workflowDataDir) {
      workflowDir = path.join(this.workflowDataDir, sanitizeName(def.name));
      try { fs.mkdirSync(workflowDir, { recursive: true }); } catch { /* ignore */ }
    }
    return runScriptStep(stepDef, def, ctx, observeDir, workflowDir);
  }

  private applyResult(
    sr: StepRun,
    observeSpec: ObserveSpec | undefined,
    res: StepRunResult,
    runDir: string,
  ): void {
    sr.result = res.result;
    sr.error = res.error;
    sr.guidanceSnapshot = res.guidanceSnapshot;
    sr.status = res.failed ? 'failed' : 'done';
    sr.completedAt = now();
    if (sr.status === 'done' && observeSpec) {
      const observed = captureObserve(observeSpec, sr.result, runDir);
      if (observed) sr.observe = observed;
    }
  }

  private resolveInputs(def: WorkflowDef, provided: Record<string, string>): Record<string, string> {
    const inputs: Record<string, string> = { ...provided };
    for (const inp of def.inputs ?? []) {
      if (inputs[inp.name] === undefined) {
        if (inp.default !== undefined) inputs[inp.name] = inp.default;
        else if (inp.required) throw new Error(`workflow "${def.name}" missing required input "${inp.name}"`);
      }
    }
    return inputs;
  }

  private emit(run: WorkflowRun): void {
    this.store.persist(run);
    this.onUpdate?.(run);
  }
}

/** 捕获 observe 输出；源缺失则返回 null（observe 是可选侧通道，不应阻断 run） */
function captureObserve(spec: ObserveSpec, result: string, runDir: string): ObserveOutput | null {
  if (spec.from === 'result') {
    if (spec.as === 'inline') return { label: spec.label, as: 'inline', content: result };
    return { label: spec.label, as: 'artifact', content: result };
  }
  const fileRel = spec.from.file;
  const abs = path.isAbsolute(fileRel) ? fileRel : path.resolve(runDir, fileRel);
  if (spec.as === 'artifact') {
    return fs.existsSync(abs) ? { label: spec.label, as: 'artifact', artifactPath: abs } : null;
  }
  try {
    return { label: spec.label, as: 'inline', content: fs.readFileSync(abs, 'utf-8') };
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

/** run 结束后若 workspace 实质为空（无文件，.observe 也空）则删掉，避免堆一堆空目录 */
function cleanupEmptyRunDir(runDir: string): void {
  try {
    const entries = fs.readdirSync(runDir);
    const empty =
      entries.length === 0 ||
      (entries.length === 1 &&
        entries[0] === '.observe' &&
        fs.readdirSync(path.join(runDir, '.observe')).length === 0);
    if (empty) fs.rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** workflow 名 → 安全目录名 */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
