/**
 * WorkflowRunStore — run 状态持久化
 *
 * 见 dev-plans/workflow-feature.md §5。
 *
 *   - workflow-runs.json：所有 run 的状态/历史（单 JSON 数组，截断到最近 HISTORY_CAP 条）。
 *     MVP 单文件；规模化再迁 SQLite。
 *   - 每 run 一个 workspace 目录：<runsDir>/<runId>/（含 .observe 子目录）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRun } from './types';

/** 历史保留上限（超出丢最旧） */
const HISTORY_CAP = 200;

export class WorkflowRunStore {
  constructor(
    private readonly statePath: string,
    private readonly runsDir: string,
  ) {}

  /** 创建一次新 run（分配 id + 建 workspace 目录），状态 running、steps 空，未持久化 */
  newRun(workflowName: string, inputs: Record<string, string>, trigger?: string): WorkflowRun {
    const id = this.allocateId();
    const runDir = path.join(this.runsDir, id);
    fs.mkdirSync(path.join(runDir, '.observe'), { recursive: true });
    return {
      id,
      workflowName,
      inputs,
      status: 'running',
      runDir,
      steps: [],
      trigger,
      createdAt: new Date().toISOString(),
    };
  }

  /** upsert 一次 run（按 id），写回文件 */
  persist(run: WorkflowRun): void {
    const all = this.load();
    const idx = all.findIndex(r => r.id === run.id);
    if (idx === -1) all.unshift(run);
    else all[idx] = run;
    const capped = all.slice(0, HISTORY_CAP);
    this.write(capped);
  }

  load(): WorkflowRun[] {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  get(id: string): WorkflowRun | null {
    return this.load().find(r => r.id === id) ?? null;
  }

  // ===== Internal =====

  /** wf-YYYYMMDD-NNNN，NNNN = 当天已有 run 数 + 1 */
  private allocateId(): string {
    const d = new Date();
    const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    const prefix = `wf-${date}-`;
    const todayCount = this.load().filter(r => r.id.startsWith(prefix)).length;
    return `${prefix}${String(todayCount + 1).padStart(4, '0')}`;
  }

  private write(runs: WorkflowRun[]): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(runs, null, 2), 'utf-8');
    fs.renameSync(tmp, this.statePath);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
