/**
 * 模板渲染 + script 环境变量构建
 *
 * 见 dev-plans/workflow-feature.md §4.3。
 *
 * 两种插值通道，刻意分开：
 *   - agent prompt / guidance：用 {{input.X}} / {{steps.ID.result}} 文本替换（注入进 LLM 输入是安全的）。
 *   - script：**不**把值插进 shell 命令（注入风险），改注入环境变量，脚本自己读。
 *
 * 模板语法刻意保持「无逻辑」：只做变量替换，无条件/循环（留 phase 2）。
 */

import type { RenderContext } from './types';

/** 匹配 {{ ... }}，捕获去空白后的表达式 */
const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** 专门匹配 {{steps.<id>.result}}（id 同 resolveExpr 的字符集），用于依赖推断 */
const STEP_REF = /\{\{\s*steps\.([A-Za-z0-9_-]+)\.result\s*\}\}/g;

/**
 * 抽取文本里所有 {{steps.<id>.result}} 引用的 step id（去重前的原始顺序）。
 * 用于 registry 把「数据引用」并入 dependsOn —— 引用某 step 的 result 即隐含依赖它。
 */
export function extractTemplateStepRefs(text: string | undefined): string[] {
  if (!text) return [];
  const ids: string[] = [];
  STEP_REF.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STEP_REF.exec(text)) !== null) ids.push(m[1]);
  return ids;
}

/**
 * 渲染模板文本：替换 {{input.X}} 和 {{steps.ID.result}}。
 * 未知变量替换为空串（不抛错——缺失的上游 result 在 DAG 调度层已保证不会发生；
 * 缺失的 input 视为用户未传，按空处理）。
 */
export function render(text: string | undefined, ctx: RenderContext): string {
  if (!text) return '';
  return text.replace(PLACEHOLDER, (_full, expr: string) => {
    const value = resolveExpr(expr, ctx);
    return value ?? '';
  });
}

/** 解析单个表达式，返回字符串或 undefined（未知） */
function resolveExpr(expr: string, ctx: RenderContext): string | undefined {
  // input.<name>
  const inputMatch = /^input\.([A-Za-z0-9_]+)$/.exec(expr);
  if (inputMatch) {
    return ctx.inputs[inputMatch[1]];
  }
  // steps.<id>.result
  const stepMatch = /^steps\.([A-Za-z0-9_-]+)\.result$/.exec(expr);
  if (stepMatch) {
    return ctx.stepResults[stepMatch[1]];
  }
  return undefined;
}

/** 把名字规范成合法的环境变量段（大写 + 非字母数字转下划线） */
export function envSegment(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

/**
 * 为 script step 构建环境变量：
 *   WF_INPUT_<NAME>        每个 run 输入
 *   WF_STEP_<ID>_RESULT    每个已完成 step 的 result
 *   WF_RUN_DIR             本次 run 的共享 workspace（每 run 全新，临时）
 *   WF_OBSERVE_DIR         observe 产物约定目录（= runDir 下 .observe）
 *   WF_WORKFLOW_DIR        本 workflow 的持久目录（跨 run 保留；可选）
 *
 * 不含 process.env —— 调用方（stepRunners）负责合并 process.env，这里只产出 workflow 注入项，
 * 保持纯函数、可单测。
 */
export function buildScriptEnv(ctx: RenderContext, observeDir: string, workflowDir?: string): Record<string, string> {
  const env: Record<string, string> = {
    WF_RUN_DIR: ctx.runDir,
    WF_OBSERVE_DIR: observeDir,
  };
  if (workflowDir) env.WF_WORKFLOW_DIR = workflowDir;
  for (const [k, v] of Object.entries(ctx.inputs)) {
    env[`WF_INPUT_${envSegment(k)}`] = v;
  }
  for (const [id, result] of Object.entries(ctx.stepResults)) {
    env[`WF_STEP_${envSegment(id)}_RESULT`] = result;
  }
  return env;
}
