/**
 * stepRunners — 按 kind 执行单个 step
 *
 * 见 dev-plans/workflow-feature.md §4.5。
 *
 * 统一返回 StepRunResult，使 DAG 调度器对 agent / script 透明。
 *   - agent：建在 runOneShot 上（隔离 session，不碰任何活 agent）。三通道映射：
 *       persona.systemPrompt → systemPrompt ; guidance → customRules ; prompt → processUserInput
 *   - script：child_process exec，cwd=runDir，env=process.env + buildScriptEnv，捕获 stdout=result。
 */

import { spawn } from 'child_process';
import * as path from 'path';
import { runOneShot } from '../agent/IsolatedRunner';
import { render, buildScriptEnv } from './template';
import type { PersonaConfig } from '../agent/PersonaRegistry';
import type { WorkflowDef, WorkflowStep, RenderContext } from './types';

interface ExecErr extends Error { stdout?: string; stderr?: string }

interface ShellOpts {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  maxBuffer: number;
}

/**
 * 跑一条 shell 命令并捕获 stdout。
 *
 * 关键：用 `spawn('/bin/sh', ['-c', cmd], { detached: true })` 让脚本成为**独立进程组**
 * 的 leader（exec 不会真正建组——实测 process.kill(-pid) 报 ESRCH，只杀得掉 sh，孙子
 * 进程仍持有 stdout pipe，要等它自己跑完）。取消/超时/超 buffer 时 `process.kill(-pid)`
 * SIGKILL 整组，连 sleep / 子命令一起杀，绝不留还在写 WF_RUN_DIR 的孤儿。
 * Windows 无进程组语义 → 退化为 shell + child.kill()。
 */
function runShell(command: string, opts: ShellOpts, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn(command, { shell: true, cwd: opts.cwd, env: opts.env })
      : spawn('/bin/sh', ['-c', command], { detached: true, cwd: opts.cwd, env: opts.env });

    let stdout = '';
    let stderr = '';
    let overBuffer = false;
    let timedOut = false;
    let settled = false;

    const killGroup = (): void => {
      const pid = child.pid;
      if (pid === undefined) return;
      try {
        if (!isWin) process.kill(-pid, 'SIGKILL');
        else child.kill();
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const onAbort = (): void => killGroup();

    const timer = setTimeout(() => { timedOut = true; killGroup(); }, opts.timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > opts.maxBuffer) { overBuffer = true; stdout = stdout.slice(0, opts.maxBuffer); killGroup(); }
    });
    child.stderr?.on('data', (d: Buffer) => {
      if (stderr.length < opts.maxBuffer) stderr += d.toString();
    });

    const settle = (err?: ExecErr): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); }
      else resolve(stdout);
    };

    child.on('error', (e) => settle(e as ExecErr)); // spawn 自身失败（如 /bin/sh 缺失）
    child.on('close', (code, sig) => {
      if (overBuffer) return settle(new Error(`script exceeded maxBuffer (${opts.maxBuffer} bytes)`) as ExecErr);
      if (timedOut) return settle(new Error('script timed out') as ExecErr);
      if (signal?.aborted) return settle(new Error('cancelled') as ExecErr);
      if (code === 0) return settle();
      return settle(new Error(stderr.trim() || `script exited with code ${code}${sig ? ` (${sig})` : ''}`) as ExecErr);
    });

    if (signal?.aborted) killGroup();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** 默认 agent 工具集（同 VirtualWorkerPool ALL_POOLED_TOOLS） */
const DEFAULT_AGENT_TOOLS = [
  'Bash', 'Glob', 'Grep', 'Read', 'Write', 'Edit',
  'TodoWrite', 'Skill', 'NotebookEdit',
];
/** 临时 agent 排除编排类工具（见 §13：步骤不做编排/不起 workflow） */
const EXCLUDED_TOOLS = ['Task', 'AskUser'];

/** script stdout 上限（避免内存爆） */
const SCRIPT_MAX_BUFFER = 16 * 1024 * 1024;

export interface StepRunResult {
  result: string;
  failed: boolean;
  error?: string;
  /** 因取消（abort）中止：executor 据此把该 step 记为 skipped 而非 failed */
  aborted?: boolean;
  /** agent step：渲染后的 guidance（→ run 记录 guidanceSnapshot） */
  guidanceSnapshot?: string;
}

export interface AgentStepDeps {
  /** 额外 skills 目录（由 executor 注入，= buildSkillsExtraDirs(runDir)） */
  skillsExtraDirs?: import('sema-core/types').SemaCoreConfig['skillsExtraDirs'];
  /** 主 agent 每轮回复回调（→ executor 推 UI 节点进度） */
  onMessage?: (content: string) => void;
  /** 取消信号：abort 时立即中止隔离 session */
  signal?: AbortSignal;
}

/** 执行 agent step：隔离 session via runOneShot */
export async function runAgentStep(
  step: WorkflowStep,
  persona: PersonaConfig,
  def: WorkflowDef,
  ctx: RenderContext,
  deps: AgentStepDeps = {},
): Promise<StepRunResult> {
  const prompt = render(step.prompt, ctx);
  const guidance = render(
    [def.guidance, step.guidance].filter(Boolean).join('\n\n'),
    ctx,
  );

  const useTools = (persona.tools ?? DEFAULT_AGENT_TOOLS)
    .filter(t => !EXCLUDED_TOOLS.includes(t));

  const res = await runOneShot({
    prompt,
    workingDir: ctx.runDir,
    instanceId: `wf-${step.id}-${Date.now().toString(36)}`,
    useTools,
    systemPrompt: persona.systemPrompt || undefined,
    customRules: guidance || undefined,
    skillsExtraDirs: deps.skillsExtraDirs,
    timeoutMs: (step.timeout ?? 600) * 1000,
    // 无人值守：全跳过权限
    skipPermissions: { fileEdit: true, bashExec: true, skill: true, mcpTool: true },
    onMessage: deps.onMessage ? (d) => deps.onMessage!(d.content) : undefined,
    abortSignal: deps.signal,
  });

  return {
    result: res.text,
    failed: res.timedOut || res.aborted,
    aborted: res.aborted,
    error: res.aborted
      ? 'cancelled'
      : res.timedOut ? `agent step timed out after ${step.timeout ?? 600}s` : undefined,
    guidanceSnapshot: guidance || undefined,
  };
}

/** 执行 script step：child_process exec，cwd=runDir，注入 WF_* 环境变量 */
export async function runScriptStep(
  step: WorkflowStep,
  def: WorkflowDef,
  ctx: RenderContext,
  observeDir: string,
  workflowDir?: string,
  signal?: AbortSignal,
): Promise<StepRunResult> {
  // 命令：run 内联优先；否则 scriptFile（相对定义目录解析后直接执行，需可执行/带 shebang）
  let command = step.run;
  if (!command && step.scriptFile) {
    const resolved = path.isAbsolute(step.scriptFile)
      ? step.scriptFile
      : path.resolve(path.dirname(def.filePath), step.scriptFile);
    command = JSON.stringify(resolved); // 引号包裹防空格
  }
  if (!command) {
    return { result: '', failed: true, error: `script step "${step.id}" has neither run nor scriptFile` };
  }

  const env = { ...process.env, ...buildScriptEnv(ctx, observeDir, workflowDir) };

  try {
    const stdout = await runShell(command, {
      cwd: ctx.runDir,
      env,
      timeoutMs: (step.timeout ?? 600) * 1000,
      maxBuffer: SCRIPT_MAX_BUFFER,
    }, signal);
    return { result: stdout.trim(), failed: false };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    const aborted = signal?.aborted === true;
    return {
      result: (err.stdout ?? '').trim(),
      failed: true,
      aborted,
      error: aborted ? 'cancelled' : (err.stderr?.trim() || err.message || 'script failed'),
    };
  }
}
