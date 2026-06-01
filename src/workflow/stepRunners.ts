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

import { exec } from 'child_process';
import * as path from 'path';
import { promisify } from 'util';
import { runOneShot } from '../agent/IsolatedRunner';
import { render, buildScriptEnv } from './template';
import type { PersonaConfig } from '../agent/PersonaRegistry';
import type { WorkflowDef, WorkflowStep, RenderContext } from './types';

const execAsync = promisify(exec);

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
  /** agent step：渲染后的 guidance（→ run 记录 guidanceSnapshot） */
  guidanceSnapshot?: string;
}

export interface AgentStepDeps {
  /** 额外 skills 目录（由 executor 注入，= buildSkillsExtraDirs(runDir)） */
  skillsExtraDirs?: import('sema-core/types').SemaCoreConfig['skillsExtraDirs'];
  /** 主 agent 每轮回复回调（→ executor 推 UI 节点进度） */
  onMessage?: (content: string) => void;
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
  });

  return {
    result: res.text,
    failed: res.timedOut,
    error: res.timedOut ? `agent step timed out after ${step.timeout ?? 600}s` : undefined,
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
    const { stdout } = await execAsync(command, {
      cwd: ctx.runDir,
      env,
      timeout: (step.timeout ?? 600) * 1000,
      maxBuffer: SCRIPT_MAX_BUFFER,
    });
    return { result: stdout.trim(), failed: false };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return {
      result: (err.stdout ?? '').trim(),
      failed: true,
      error: (err.stderr?.trim() || err.message || 'script failed'),
    };
  }
}
