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
 *   - id = `<workflow 名>-<NNNN>`，NNNN 为该 workflow 的单调序号（max+1，抗碰撞）。
 *   - 保留策略：**每个 workflow 各留最近 PER_WORKFLOW_CAP 条历史记录**；超出丢最旧记录。
 *   - workspace 不再每 run 一个，而是**每 workflow 一个持久共享目录**（run+data 合体），
 *     由调用方解析后传入 newRun；故 store 不再创建/删除 workspace 目录。
 */

import * as fs from 'fs';
import * as path from 'path';
import type { WorkflowRun } from './types';

/** 每个 workflow 保留的历史 run 条数（超出丢最旧 + GC 目录） */
const PER_WORKFLOW_CAP = 10;
/** 运行中中间态的防抖落盘间隔 */
const FLUSH_DEBOUNCE_MS = 400;

export class WorkflowRunStore {
  /** 内存权威态，最新在前 */
  private runs: WorkflowRun[] = [];
  /** id → run（与 runs 持同一对象引用），O(1) 查询/upsert */
  private readonly byId = new Map<string, WorkflowRun>();
  /** id 前缀 → 已分配的最大序号（单调，永不回退；按需从盘上 runs 懒播种） */
  private readonly seqByPrefix = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;
  private readonly perWorkflowCap: number;

  constructor(
    private readonly statePath: string,
    perWorkflowCap = PER_WORKFLOW_CAP,
  ) {
    this.perWorkflowCap = perWorkflowCap;
    this.runs = this.readFromDisk();
    for (const r of this.runs) this.byId.set(r.id, r);
  }

  /**
   * 创建一次新 run（分配 id），状态 running、steps 空，未持久化。
   * workspaceDir 由调用方解析（默认 <dataDir>/<name>/ 或用户自定义），跨 run 持久共享；
   * 此处确保它和其 .observe 子目录存在。
   */
  newRun(workflowName: string, inputs: Record<string, string>, workspaceDir: string, trigger?: string): WorkflowRun {
    const id = this.allocateId(workflowName);
    fs.mkdirSync(path.join(workspaceDir, '.observe'), { recursive: true });
    return {
      id,
      workflowName,
      inputs,
      status: 'running',
      runDir: workspaceDir,
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

    this.enforceCap(run.workflowName);

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

  /**
   * id = `<sanitized workflow 名>-<NNNN>`，NNNN = 该前缀单调序号 + 1。
   * 用内存计数器（不只看 this.runs，因 newRun 此刻尚未 persist）；首次按需从盘上 runs
   * 播种最大值，之后只增不减 —— 故淘汰最旧 run 后也绝不回退、不碰撞。
   */
  private allocateId(workflowName: string): string {
    const prefix = `${sanitizeName(workflowName)}-`;
    let last = this.seqByPrefix.get(prefix);
    if (last === undefined) {
      last = 0;
      for (const r of this.runs) {
        if (!r.id.startsWith(prefix)) continue;
        const n = parseInt(r.id.slice(prefix.length), 10);
        if (Number.isFinite(n) && n > last) last = n;
      }
    }
    const next = last + 1;
    this.seqByPrefix.set(prefix, next);
    return `${prefix}${String(next).padStart(4, '0')}`;
  }

  /**
   * 把某 workflow 的历史 run 记录截到最近 perWorkflowCap 条（只丢记录，不动 workspace
   * 目录——它现在是跨 run 共享的持久目录，归用户所有）。
   */
  private enforceCap(workflowName: string): void {
    let kept = 0;
    for (let i = 0; i < this.runs.length; ) {
      const r = this.runs[i];
      if (r.workflowName !== workflowName) { i++; continue; }
      kept++;
      if (kept > this.perWorkflowCap) {
        this.runs.splice(i, 1);
        if (this.byId.get(r.id) === r) this.byId.delete(r.id);
        // 不自增 i：splice 后当前位是下一条
      } else {
        i++;
      }
    }
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

/** workflow 名 → 安全 id/目录段（非字母数字._- 转下划线） */
function sanitizeName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]/g, '_');
}
