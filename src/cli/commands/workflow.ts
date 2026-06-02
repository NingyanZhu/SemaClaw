/**
 * semaclaw workflow <subcommand> — CLI 入口
 *
 * 见 dev-plans/workflow-feature.md §6（v1 手动触发）。
 * 独立进程内构造 registry + executor + store 跑一次 workflow（不连 daemon、不推 WS）。
 */

import { config } from '../../config';
import { PersonaRegistry } from '../../agent/PersonaRegistry';
import { WorkflowRegistry } from '../../workflow/WorkflowRegistry';
import { WorkflowRunStore } from '../../workflow/runStore';
import { WorkflowExecutor } from '../../workflow/WorkflowExecutor';
import type { WorkflowRun } from '../../workflow/types';

/** semaclaw workflow list */
export function cmdWorkflowList(opts: { json?: boolean } = {}): void {
  const registry = new WorkflowRegistry(config.paths.workflowsDir);
  const defs = registry.list();
  registry.destroy();

  if (opts.json) {
    console.log(JSON.stringify(defs.map(d => ({
      name: d.name, description: d.description, steps: d.steps.length,
    })), null, 2));
    return;
  }

  if (defs.length === 0) {
    console.log(`(no workflows in ${config.paths.workflowsDir})`);
    return;
  }
  for (const d of defs) {
    const kinds = d.steps.map(s => s.kind[0]).join('');
    console.log(`• ${d.name}  [${d.steps.length} steps: ${kinds}]  ${d.description ?? ''}`);
  }
}

/** semaclaw workflow run <name> --input k=v ... */
export async function cmdWorkflowRun(
  name: string,
  opts: { input?: string[]; json?: boolean },
): Promise<void> {
  const registry = new WorkflowRegistry(config.paths.workflowsDir);
  const def = registry.get(name);
  registry.destroy();
  if (!def) {
    throw new Error(`workflow "${name}" not found or invalid (dir: ${config.paths.workflowsDir})`);
  }

  const inputs = parseInputs(opts.input ?? []);

  const personaRegistry = new PersonaRegistry(config.paths.virtualAgentsDir);
  const store = new WorkflowRunStore(config.paths.workflowStatePath);
  const executor = new WorkflowExecutor({
    store,
    getPersona: (n) => personaRegistry.get(n),
    workflowDataDir: config.paths.workflowDataDir,
  });

  console.log(`▶ running workflow "${def.name}" (${def.steps.length} steps)…\n`);
  const run = await executor.run(def, inputs, 'cli');
  personaRegistry.destroy();

  if (opts.json) {
    console.log(JSON.stringify(run, null, 2));
  } else {
    printRun(run);
  }

  // 一次性 CLI：跑完即退（确保 sema-core / watcher 句柄不滞留）
  process.exit(run.status === 'done' ? 0 : 1);
}

// ===== helpers =====

function parseInputs(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const eq = p.indexOf('=');
    if (eq === -1) throw new Error(`--input must be k=v, got "${p}"`);
    out[p.slice(0, eq)] = p.slice(eq + 1);
  }
  return out;
}

function printRun(run: WorkflowRun): void {
  const glyph: Record<string, string> = {
    done: '✓', failed: '✗', skipped: '∅', running: '…', pending: '·',
  };
  console.log(`\n── run ${run.id} → ${run.status} ──`);
  console.log(`workspace: ${run.runDir}\n`);
  for (const s of run.steps) {
    console.log(`${glyph[s.status] ?? '?'} ${s.id} (${s.kind})`);
    if (s.error) console.log(`    error: ${s.error}`);
    else if (s.result) console.log(`    result: ${preview(s.result)}`);
    if (s.observe) console.log(`    observe[${s.observe.label}]: ${s.observe.as}${s.observe.artifactPath ? ` → ${s.observe.artifactPath}` : ''}`);
  }
}

function preview(text: string, max = 160): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? oneLine.slice(0, max) + '…' : oneLine;
}
