/**
 * WorkflowRegistry — 加载 + 校验 workflow 定义
 *
 * 见 dev-plans/workflow-feature.md §3。
 *
 * 扫 <workflowsDir>/*.md，frontmatter 用 js-yaml 解析（嵌套 steps/inputs/observe），
 * 校验 DAG（id 唯一、dependsOn 存在、无环、kind 合法、agent 需 persona、script 需 run/scriptFile）。
 * 非法文件跳过并 warn（不污染 list）。仿 PersonaRegistry 结构 + 热重载。
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { envSegment, extractTemplateStepRefs } from './template';
import type { WorkflowDef, WorkflowStep, WorkflowInput, StepKind, ObserveSpec, ObserveFrom } from './types';

const VALID_KINDS: ReadonlySet<string> = new Set<StepKind>(['agent', 'script']);

export class WorkflowRegistry {
  private workflows = new Map<string, WorkflowDef>();
  private watcher: fs.FSWatcher | null = null;

  constructor(private readonly dir: string) {
    // 确保目录存在：否则 fs.watch 挂不上，agent/CLI 后来新建的 workflow 永远看不见
    try { fs.mkdirSync(this.dir, { recursive: true }); } catch { /* ignore */ }
    this.loadAll();
    this.startWatcher();
  }

  get(name: string): WorkflowDef | null {
    return this.workflows.get(name) ?? null;
  }

  list(): WorkflowDef[] {
    return Array.from(this.workflows.values());
  }

  reload(): void {
    this.loadAll();
  }

  destroy(): void {
    this.watcher?.close();
    this.watcher = null;
  }

  // ===== Internal =====

  private loadAll(): void {
    const map = new Map<string, WorkflowDef>();
    if (!fs.existsSync(this.dir)) {
      this.workflows = map;
      return;
    }
    for (const file of fs.readdirSync(this.dir).filter(f => f.endsWith('.md'))) {
      const filePath = path.join(this.dir, file);
      try {
        const def = parseWorkflowFile(filePath);
        map.set(def.name, def);
      } catch (e) {
        console.warn(`[WorkflowRegistry] Skip ${file}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.workflows = map;
    console.warn(`[WorkflowRegistry] Loaded ${map.size} workflow(s): ${Array.from(map.keys()).join(', ') || '(none)'}`);
  }

  private startWatcher(): void {
    if (!fs.existsSync(this.dir)) return;
    try {
      this.watcher = fs.watch(this.dir, { persistent: false }, (_e, filename) => {
        if (filename && filename.endsWith('.md')) this.loadAll();
      });
    } catch {
      /* hot reload disabled */
    }
  }
}

/** 解析单个 .md → WorkflowDef，非法抛错 */
export function parseWorkflowFile(filePath: string): WorkflowDef {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const fmText = extractFrontmatter(raw);
  if (fmText === null) throw new Error('no frontmatter');

  const parsed = parseYaml(fmText);
  if (!parsed || typeof parsed !== 'object') throw new Error('frontmatter is not a mapping');

  const def = normalizeAndValidate(parsed as Record<string, unknown>, filePath);
  return def;
}

/** 取 --- ... --- 之间的文本 */
function extractFrontmatter(raw: string): string | null {
  const lines = raw.split('\n');
  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) start = i;
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) return null;
  return lines.slice(start + 1, end).join('\n');
}

function normalizeAndValidate(fm: Record<string, unknown>, filePath: string): WorkflowDef {
  const fileName = path.basename(filePath, '.md');
  const name = typeof fm.name === 'string' && fm.name.trim() ? fm.name.trim() : fileName;

  const rawSteps = fm.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error('steps must be a non-empty array');
  }

  const ids = new Set<string>();
  const steps: WorkflowStep[] = rawSteps.map((s, i) => normalizeStep(s, i, ids));

  // 数据引用 → 隐式依赖：把 {{steps.X.result}} / $WF_STEP_X_RESULT 引用并入 dependsOn，
  // 保证「引用」与「依赖」永不脱节（否则被引用的 step 可能还没跑完就渲染成空串）。
  inferDependencies(steps, ids);

  // dependsOn 引用必须存在（含推断进来的——typo 在此处 fail loud，而非静默空渲染）
  for (const s of steps) {
    for (const d of s.dependsOn ?? []) {
      if (!ids.has(d)) throw new Error(`step "${s.id}" dependsOn unknown step "${d}"`);
    }
  }
  // 无环
  assertAcyclic(steps);

  // workflow 级 guidance 会拼进每个 agent step，引用 step 会逼所有 agent step 依赖它（必成环）——禁止。
  const guidance = str(fm.guidance);
  if (extractTemplateStepRefs(guidance).length > 0) {
    throw new Error(
      'workflow-level guidance must not reference {{steps.*.result}} (it applies to every agent step); ' +
      "move step-dependent text into a step's prompt/guidance",
    );
  }

  return {
    name,
    description: str(fm.description),
    version: str(fm.version),
    inputs: normalizeInputs(fm.inputs),
    guidance,
    steps,
    filePath,
    source: 'user',
  };
}

function normalizeStep(raw: unknown, idx: number, ids: Set<string>): WorkflowStep {
  if (!raw || typeof raw !== 'object') throw new Error(`step[${idx}] is not a mapping`);
  const s = raw as Record<string, unknown>;

  const id = str(s.id);
  if (!id) throw new Error(`step[${idx}] missing id`);
  if (ids.has(id)) throw new Error(`duplicate step id "${id}"`);
  ids.add(id);

  const kind = str(s.kind);
  if (!kind || !VALID_KINDS.has(kind)) throw new Error(`step "${id}" kind must be agent|script`);

  const dependsOn = Array.isArray(s.dependsOn) ? s.dependsOn.map(String) : undefined;
  const timeout = typeof s.timeout === 'number' ? s.timeout : undefined;

  const step: WorkflowStep = {
    id,
    kind: kind as StepKind,
    dependsOn,
    timeout,
    guidance: str(s.guidance),
    observe: normalizeObserve(s.observe, id),
  };

  if (kind === 'agent') {
    step.persona = str(s.persona);
    step.prompt = str(s.prompt);
    if (!step.persona) throw new Error(`agent step "${id}" missing persona`);
  } else {
    step.run = str(s.run);
    step.scriptFile = str(s.scriptFile);
    if (!step.run && !step.scriptFile) throw new Error(`script step "${id}" needs run or scriptFile`);
  }

  return step;
}

function normalizeObserve(raw: unknown, stepId: string): ObserveSpec | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') throw new Error(`step "${stepId}" observe must be a mapping`);
  const o = raw as Record<string, unknown>;
  const label = str(o.label);
  if (!label) throw new Error(`step "${stepId}" observe missing label`);
  const as = str(o.as) === 'artifact' ? 'artifact' : 'inline';

  let from: ObserveFrom;
  if (o.from === 'result' || o.from === undefined) {
    from = 'result';
  } else if (o.from && typeof o.from === 'object' && typeof (o.from as Record<string, unknown>).file === 'string') {
    from = { file: (o.from as { file: string }).file };
  } else {
    throw new Error(`step "${stepId}" observe.from must be "result" or { file }`);
  }

  return { label, as, from };
}

function normalizeInputs(raw: unknown): WorkflowInput[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.map((r, i) => {
    if (!r || typeof r !== 'object') throw new Error(`inputs[${i}] is not a mapping`);
    const o = r as Record<string, unknown>;
    const name = str(o.name);
    if (!name) throw new Error(`inputs[${i}] missing name`);
    return {
      name,
      required: o.required === true,
      default: str(o.default),
      description: str(o.description),
    };
  });
}

/**
 * 依赖推断：把每个 step 对其它 step 结果的「数据引用」并入它的 dependsOn（并集）。
 *   - agent：扫 prompt / step 级 guidance 里的 {{steps.<id>.result}}（未知 id 立即报错）
 *   - script：扫内联 run 里的 $WF_STEP_<SEG>_RESULT（按已知 id 正向匹配，envSegment 有损故不反推）
 *
 * 引用 = 必须等它跑完，所以并入 dependsOn 永远安全、不会引入伪依赖。
 * 注：scriptFile（外部脚本文件）不扫描，其依赖须显式声明 dependsOn。
 * 自引用（引用自己的 result）会在 assertAcyclic 处作为环报错。
 */
function inferDependencies(steps: WorkflowStep[], ids: Set<string>): void {
  for (const s of steps) {
    const deps = new Set<string>(s.dependsOn ?? []);

    // agent: {{steps.X.result}} in prompt + step-level guidance
    for (const id of [...extractTemplateStepRefs(s.prompt), ...extractTemplateStepRefs(s.guidance)]) {
      if (!ids.has(id)) {
        throw new Error(`step "${s.id}" references unknown step "${id}" (in prompt/guidance)`);
      }
      deps.add(id);
    }

    // script: $WF_STEP_<SEG>_RESULT in inline run（正向匹配每个已知 id 的段名）
    if (s.kind === 'script' && s.run) {
      for (const id of ids) {
        if (id !== s.id && s.run.includes(`WF_STEP_${envSegment(id)}_RESULT`)) deps.add(id);
      }
    }

    if (deps.size > 0) s.dependsOn = [...deps];
  }
}

/** 拓扑环检测（DFS 三色） */
function assertAcyclic(steps: WorkflowStep[]): void {
  const depMap = new Map(steps.map(s => [s.id, s.dependsOn ?? []]));
  const state = new Map<string, 0 | 1 | 2>(); // 0=未访问 1=在栈 2=完成

  const visit = (id: string): void => {
    const st = state.get(id) ?? 0;
    if (st === 2) return;
    if (st === 1) throw new Error(`dependency cycle involving "${id}"`);
    state.set(id, 1);
    for (const d of depMap.get(id) ?? []) visit(d);
    state.set(id, 2);
  };

  for (const s of steps) visit(s.id);
}

/** 取字符串字段（非字符串 → undefined） */
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
