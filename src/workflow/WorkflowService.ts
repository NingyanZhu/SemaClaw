/**
 * WorkflowService — daemon 内的 workflow 协调器
 *
 * 见 dev-plans/workflow-feature.md §6/§8。
 * 持有 registry + store + executor 三件套，是 WebSocketGateway 触发/查询 workflow 的唯一入口。
 * 与 AgentPool / DispatchBridge 零耦合。
 *
 * 接线（index.ts，照 DispatchBridge 范式）：
 *   const wf = new WorkflowService({ ...config.paths, getPersona })
 *   wf.setWsNotify(run => wsGateway.notifyWorkflowUpdate(run))
 *   wsGateway.setWorkflowService(wf)
 */

import { WorkflowRegistry } from './WorkflowRegistry';
import { WorkflowRunStore } from './runStore';
import { WorkflowExecutor } from './WorkflowExecutor';
import { editWorkflowFile, type EditPatch } from './editDef';
import type { PersonaConfig } from '../agent/PersonaRegistry';
import type { WorkflowRun } from './types';

export interface WorkflowDefSummary {
  name: string;
  description?: string;
  stepCount: number;
  inputs: { name: string; required?: boolean; default?: string }[];
  /** workflow 级 guidance（dock 可编辑） */
  guidance?: string;
  /** 各 step 的可编辑原始字段（注意：是 def 模板值，非 run 的渲染快照） */
  steps: { id: string; kind: 'agent' | 'script'; guidance?: string; timeout?: number }[];
}

export interface WorkflowServiceOpts {
  workflowsDir: string;
  workflowStatePath: string;
  workflowRunsDir: string;
  workflowDataDir?: string;
  getPersona: (name: string) => PersonaConfig | null;
  concurrency?: number;
}

export class WorkflowService {
  private readonly registry: WorkflowRegistry;
  private readonly store: WorkflowRunStore;
  private readonly executor: WorkflowExecutor;
  private wsNotify: ((run: WorkflowRun) => void) | null = null;

  constructor(opts: WorkflowServiceOpts) {
    this.registry = new WorkflowRegistry(opts.workflowsDir);
    this.store = new WorkflowRunStore(opts.workflowStatePath, opts.workflowRunsDir);
    this.executor = new WorkflowExecutor({
      store: this.store,
      getPersona: opts.getPersona,
      concurrency: opts.concurrency,
      workflowDataDir: opts.workflowDataDir,
      onUpdate: (run) => this.wsNotify?.(run),
    });
  }

  setWsNotify(fn: (run: WorkflowRun) => void): void {
    this.wsNotify = fn;
  }

  /** 可用 workflow 定义（摘要，给 dock 列表/选择器） */
  listDefs(): WorkflowDefSummary[] {
    this.registry.reload();   // 每次拉取都重扫，保证 agent/CLI 新建的能被看到（不依赖 watcher）
    return this.registry.list().map(d => ({
      name: d.name,
      description: d.description,
      stepCount: d.steps.length,
      inputs: (d.inputs ?? []).map(i => ({ name: i.name, required: i.required, default: i.default })),
      guidance: d.guidance,
      steps: d.steps.map(s => ({ id: s.id, kind: s.kind, guidance: s.guidance, timeout: s.timeout })),
    }));
  }

  /** 全部 run 记录（最新在前），给 dock 历史 + 初始拉取 */
  listRuns(): WorkflowRun[] {
    return this.store.load();
  }

  getRun(id: string): WorkflowRun | null {
    return this.store.get(id);
  }

  /**
   * 触发一次 run（fire-and-forget）。同步返回 runId；后续状态走 wsNotify 推送。
   * @returns { runId } 或 { error }
   */
  startRun(name: string, inputs: Record<string, string>, trigger?: string): { runId: string } | { error: string } {
    this.registry.reload();   // 触发前重扫，确保刚创建的 workflow 也能跑
    const def = this.registry.get(name);
    if (!def) return { error: `workflow "${name}" not found or invalid` };
    try {
      const { run } = this.executor.start(def, inputs, trigger);
      return { runId: run.id };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 取消（最简：停止派发新 step，标 cancelled） */
  cancel(runId: string): boolean {
    return this.executor.cancel(runId);
  }

  /**
   * 无损编辑定义（dock 可改 workflow.guidance / step.guidance / step.timeout）。
   * 改完 reload 让后续 run 用新值；历史 run 的 guidanceSnapshot 不受影响。
   */
  editStep(name: string, patch: EditPatch): { ok: true } | { error: string } {
    const def = this.registry.get(name);
    if (!def) return { error: `workflow "${name}" not found` };
    try {
      editWorkflowFile(def.filePath, patch);
      this.registry.reload();
      return { ok: true };
    } catch (e) {
      return { error: e instanceof Error ? e.message : String(e) };
    }
  }
}
