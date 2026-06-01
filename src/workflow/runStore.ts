/**
 * WorkflowRunStore — run 状态持久化
 *
 * 见 dev-plans/workflow-feature.md §5。
 *
 *   - 内存为权威态：构造时从 workflow-runs.json 读一次，之后所有读写走内存，
 *     避免每次状态变化都全量读+写文件（emit 在一次 run 里会触发 N 次）。
 *   - 落盘策略：运行中的中间态防抖批量写（FLUSH_DEBOUNCE_MS）；run 进入终态立即同步写
 *     （保证已完成 run 不丢）。tmp+rename 原子落盘。
 *   - 单写者 + 内存权威 → 消除并发 run 的 load-modify-write lost-update 竞态。
 *   - 每 run 一个 workspace 目录：<runsDir>/<runId>/（含 .observe 子目录）。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRun } from './types';

/** 历史保留上限（超出丢最旧） */
const HISTORY_CAP = 200;
/** 运行中中间态的防抖落盘间隔 */
const FLUSH_DEBOUNCE_MS = 400;

export class WorkflowRunStore {
  /** 内存权威态，最新在前 */
  private runs: WorkflowRun[] = [];
  /** id → run（与 runs 持同一对象引用），O(1) 查询/upsert */
  private readonly byId = new Map<string, WorkflowRun>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly statePath: string,
    private readonly runsDir: string,
  ) {
    this.runs = this.readFromDisk();
    for (const r of this.runs) this.byId.set(r.id, r);
  }

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

  /** upsert 一次 run（按 id）到内存；终态立即落盘，运行中防抖落盘 */
  persist(run: WorkflowRun): void {
    const existing = this.byId.get(run.id);
    if (existing) {
      const idx = this.runs.indexOf(existing);
      if (idx !== -1) this.runs[idx] = run;
      else this.runs.unshift(run);
    } else {
      this.runs.unshift(run);
    }
    this.byId.set(run.id, run);

    // cap：从尾部丢最旧
    while (this.runs.length > HISTORY_CAP) {
      const dropped = this.runs.pop()!;
      if (this.byId.get(dropped.id) === dropped) this.byId.delete(dropped.id);
    }

    if (run.status === 'running') this.scheduleFlush();
    else this.flush(); // 终态：立即落盘，确保已完成 run 不丢
  }

  /** 全部 run（最新在前）。返回浅拷贝数组（元素仍是活引用，调用方只读序列化即可）。 */
  load(): WorkflowRun[] {
    return this.runs.slice();
  }

  get(id: string): WorkflowRun | null {
    return this.byId.get(id) ?? null;
  }

  /**
   * 启动对账：把仍标 `running` 的 run 视为孤儿——进程已重启、内存里的调度循环没了，
   * 它永远不会再推进。标记为 `interrupted`，并收尾其 step（running→failed、pending→skipped）。
   * 仅应在启动时（executor 无 active run）调用。返回被对账的 run 数。
   */
  reconcileOrphans(): number {
    const ts = new Date().toISOString();
    let n = 0;
    for (const run of this.runs) {
      if (run.status !== 'running') continue;
      n++;
      run.status = 'interrupted';
      run.completedAt = run.completedAt ?? ts;
      for (const s of run.steps) {
        if (s.status === 'running') {
          s.status = 'failed';
          s.error = s.error ?? 'interrupted: daemon restarted';
          s.completedAt = s.completedAt ?? ts;
        } else if (s.status === 'pending') {
          s.status = 'skipped';
          s.completedAt = s.completedAt ?? ts;
        }
      }
    }
    if (n > 0) this.flush();
    return n;
  }

  /** 立即同步落盘（清掉待定的防抖 flush）。供关停时调用，确保中间态不丢。 */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.writeNow();
  }

  // ===== Internal =====

  /** wf-YYYYMMDD-NNNN，NNNN = 当天已有 run 数 + 1 */
  private allocateId(): string {
    const d = new Date();
    const date = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
    const prefix = `wf-${date}-`;
    const todayCount = this.runs.filter(r => r.id.startsWith(prefix)).length;
    return `${prefix}${String(todayCount + 1).padStart(4, '0')}`;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.writeNow();
    }, FLUSH_DEBOUNCE_MS);
    // 不因 pending flush 阻止进程退出（关停路径会显式 flush）
    this.flushTimer.unref?.();
  }

  private readFromDisk(): WorkflowRun[] {
    try {
      const raw = fs.readFileSync(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private writeNow(): void {
    fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
    const tmp = `${this.statePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.runs, null, 2), 'utf-8');
    fs.renameSync(tmp, this.statePath);
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}
