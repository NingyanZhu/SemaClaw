import { useState, useEffect, useMemo } from 'react';
import type { WorkflowDefSummary, WorkflowRun, WorkflowRunStatus, WfStepStatus } from '../types';
import { WorkflowGraph } from './WorkflowGraph';

interface Props {
  expanded: boolean;
  onCollapse: () => void;
  defs: WorkflowDefSummary[];
  runs: WorkflowRun[];
  error: string | null;
  onRun: (name: string, inputs: Record<string, string>) => void;
  onCancel: (runId: string) => void;
  onEdit: (name: string, patch: { stepId?: string; guidance?: string; timeout?: number }) => void;
}

type DefStep = WorkflowDefSummary['steps'][number];

const RUN_PILL: Record<WorkflowRunStatus, string> = {
  running: 'bg-[#EBF5FB] text-[#2A7BAA]',
  done: 'bg-green-50 text-green-700',
  'partial-failed': 'bg-red-50 text-red-700',
  cancelled: 'bg-gray-100 text-gray-500',
  interrupted: 'bg-amber-50 text-amber-700',
};
const STEP_PILL: Record<WfStepStatus, string> = {
  pending: 'text-gray-400',
  running: 'text-[#2A7BAA]',
  done: 'text-green-600',
  failed: 'text-red-600',
  skipped: 'text-gray-300',
};

export function WorkflowPanel(p: Props) {
  const [defName, setDefName] = useState<string>('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  // 默认选第一个 def
  useEffect(() => {
    if (!defName && p.defs.length > 0) setDefName(p.defs[0].name);
  }, [p.defs, defName]);

  const def = useMemo(() => p.defs.find(d => d.name === defName) ?? null, [p.defs, defName]);

  // 切换 picker（defName 变）→ 重置 inputs + 清选中态，让视图跟随新 workflow。
  // 只依赖 defName：避免 defs 刷新（如 edit-save 后）误触发重置。
  useEffect(() => {
    const d = p.defs.find(x => x.name === defName);
    if (!d) return;
    const init: Record<string, string> = {};
    for (const i of d.inputs) init[i.name] = i.default ?? '';
    setInputs(init);
    setSelectedRunId(null);
    setSelectedStepId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defName]);

  // 当前 run：显式选中优先；否则「所选 workflow 的最新 run」（runs 已最新在前，find 命中第一个即最新）
  const currentRun = useMemo(
    () => (selectedRunId
      ? p.runs.find(r => r.id === selectedRunId)
      : p.runs.find(r => r.workflowName === defName)) ?? null,
    [p.runs, selectedRunId, defName],
  );
  const selectedStep = currentRun?.steps.find(s => s.id === selectedStepId) ?? null;
  const currentDef = useMemo(() => p.defs.find(d => d.name === currentRun?.workflowName) ?? null, [p.defs, currentRun]);
  const defStep = currentDef?.steps.find(s => s.id === selectedStep?.id) ?? null;
  const anyRunning = p.runs.some(r => r.status === 'running');

  const missingRequired = def?.inputs.some(i => i.required && !inputs[i.name]?.trim()) ?? false;

  if (!p.expanded) return null;

  const handleRun = () => {
    if (!def || missingRequired) return;
    setSelectedRunId(null);     // 跟随最新
    setSelectedStepId(null);
    p.onRun(def.name, inputs);
  };

  return (
    <div className="flex flex-col flex-1 min-w-0 border-l border-gray-100 bg-[#F5F8FB] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-200 bg-white flex-shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-gray-700">Workflow</span>
          {anyRunning && (
            <span className="flex items-center gap-1 text-[10px] text-green-600 font-medium">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" /> Live
            </span>
          )}
        </div>
        <button onClick={p.onCollapse}
          className="text-gray-400 hover:text-gray-600 text-xs px-1.5 py-0.5 rounded hover:bg-gray-100">
          Hide ▸
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* ── Trigger ── */}
        <div className="p-3 border-b border-gray-100 bg-white">
          {p.defs.length === 0 ? (
            <p className="text-xs text-gray-400">No workflows. Author one in <code>~/semaclaw/workflows/</code> (see the <code>workflow</code> skill).</p>
          ) : (
            <>
              <select value={defName} onChange={e => setDefName(e.target.value)}
                className="w-full text-sm border border-gray-200 rounded px-2 py-1 mb-2 bg-white">
                {p.defs.map(d => <option key={d.name} value={d.name}>{d.name}</option>)}
              </select>
              {def?.description && <p className="text-[11px] text-gray-400 mb-2">{def.description}</p>}
              {def && <WorkflowGuidanceEditor defName={def.name} guidance={def.guidance} onEdit={p.onEdit} />}
              {def?.inputs.map(i => (
                <label key={i.name} className="block mb-2">
                  <span className="text-[11px] text-gray-500">{i.name}{i.required && <span className="text-red-400"> *</span>}</span>
                  <input
                    value={inputs[i.name] ?? ''}
                    placeholder={i.default ?? ''}
                    onChange={e => setInputs(prev => ({ ...prev, [i.name]: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded px-2 py-1 bg-white"
                  />
                </label>
              ))}
              <button onClick={handleRun} disabled={missingRequired}
                className={`w-full text-sm rounded px-2 py-1.5 font-medium transition-colors ${
                  missingRequired ? 'bg-gray-100 text-gray-300 cursor-not-allowed'
                    : 'bg-[#5BBFE8] text-white hover:bg-[#4AAED7]'
                }`}>
                ▶ Run
              </button>
              {p.error && <p className="text-[11px] text-red-500 mt-1.5">{p.error}</p>}
            </>
          )}
        </div>

        {/* ── Current run ── */}
        {currentRun && (
          <div className="p-3 border-b border-gray-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] text-gray-400 font-mono">{currentRun.id}</span>
              <div className="flex items-center gap-1.5">
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-medium ${RUN_PILL[currentRun.status]}`}>
                  {currentRun.status}
                </span>
                {currentRun.status === 'running' && (
                  <button onClick={() => p.onCancel(currentRun.id)}
                    className="text-[10px] text-red-500 hover:text-red-700 px-1 rounded hover:bg-red-50">
                    Cancel
                  </button>
                )}
              </div>
            </div>
            <WorkflowGraph steps={currentRun.steps} selectedId={selectedStepId} onSelect={setSelectedStepId} />
          </div>
        )}

        {!currentRun && def && p.defs.length > 0 && (
          <div className="px-3 py-2 text-[11px] text-gray-400 border-b border-gray-100">
            「{def.name}」还没有运行记录，点 ▶ Run 开始。
          </div>
        )}

        {/* ── Node detail ── */}
        {selectedStep && (
          <div className="p-3 border-b border-gray-100 bg-white text-xs">
            <div className="flex items-center gap-2 mb-1.5 flex-wrap">
              <span className="font-semibold text-gray-700">{selectedStep.id}</span>
              <span className="text-[10px] text-gray-400">{selectedStep.kind}</span>
              {selectedStep.persona && <span className="text-[10px] text-[#2A7BAA]">◆ {selectedStep.persona}</span>}
              <span className={`text-[10px] font-medium ${STEP_PILL[selectedStep.status]}`}>{selectedStep.status}</span>
            </div>
            {selectedStep.error && <p className="text-red-500 mb-1.5">⚠ {selectedStep.error}</p>}
            {selectedStep.guidanceSnapshot && (
              <Field label="guidance (read-only)"><pre className="whitespace-pre-wrap text-gray-500">{selectedStep.guidanceSnapshot}</pre></Field>
            )}
            {selectedStep.result && (
              <Field label="result"><pre className="whitespace-pre-wrap text-gray-600 max-h-40 overflow-y-auto">{selectedStep.result}</pre></Field>
            )}
            {selectedStep.observe && (
              <Field label={`observe · ${selectedStep.observe.label}`}>
                {selectedStep.observe.as === 'artifact'
                  ? <span className="text-[#2A7BAA] break-all">{selectedStep.observe.artifactPath ?? '(artifact)'}</span>
                  : <pre className="whitespace-pre-wrap text-gray-600 max-h-40 overflow-y-auto">{selectedStep.observe.content}</pre>}
              </Field>
            )}
            {currentDef && defStep && (
              <StepEditor defName={currentDef.name} step={defStep} onEdit={p.onEdit} />
            )}
          </div>
        )}

        {/* ── History ── */}
        {p.runs.length > 0 && (
          <div className="p-3">
            <div className="text-[10px] font-semibold text-gray-400 uppercase tracking-wide mb-1.5">History</div>
            <div className="flex flex-col gap-0.5">
              {p.runs.slice(0, 30).map(r => (
                <button key={r.id} onClick={() => { setSelectedRunId(r.id); setSelectedStepId(null); }}
                  className={`flex items-center justify-between text-[11px] px-2 py-1 rounded hover:bg-gray-100 ${
                    currentRun?.id === r.id ? 'bg-gray-100' : ''
                  }`}>
                  <span className="truncate text-gray-600">{r.workflowName}</span>
                  <span className="flex items-center gap-1.5 flex-shrink-0">
                    <span className={`px-1 rounded ${RUN_PILL[r.status]}`}>{r.status}</span>
                    <span className="text-gray-300">{new Date(r.createdAt).toLocaleTimeString()}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

const SAVE_BTN = (dirty: boolean) =>
  `text-xs rounded px-2 py-1 transition-colors ${dirty
    ? 'bg-[#5BBFE8] text-white hover:bg-[#4AAED7]'
    : 'bg-gray-100 text-gray-300 cursor-not-allowed'}`;

/** 节点详情里的 def 编辑器：guidance(仅 agent) + timeout，存回 .md（影响未来 run） */
function StepEditor({ defName, step, onEdit }: {
  defName: string;
  step: DefStep;
  onEdit: (name: string, patch: { stepId?: string; guidance?: string; timeout?: number }) => void;
}) {
  const [g, setG] = useState(step.guidance ?? '');
  const [t, setT] = useState(step.timeout != null ? String(step.timeout) : '');
  useEffect(() => {
    setG(step.guidance ?? '');
    setT(step.timeout != null ? String(step.timeout) : '');
  }, [step.id, step.guidance, step.timeout]);

  const dirty = g !== (step.guidance ?? '') || t !== (step.timeout != null ? String(step.timeout) : '');
  const save = () => {
    const patch: { stepId: string; guidance?: string; timeout?: number } = { stepId: step.id };
    if (step.kind === 'agent') patch.guidance = g;
    const tn = Number(t);
    if (t.trim() && Number.isFinite(tn) && tn > 0) patch.timeout = tn;
    onEdit(defName, patch);
  };

  return (
    <div className="mt-2 pt-2 border-t border-gray-100">
      <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-1">edit def · applies to future runs</div>
      {step.kind === 'agent' && (
        <label className="block mb-1.5">
          <span className="text-[10px] text-gray-500">guidance</span>
          <textarea value={g} onChange={e => setG(e.target.value)} rows={3}
            className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white font-mono" />
        </label>
      )}
      <label className="block mb-1.5">
        <span className="text-[10px] text-gray-500">timeout (s)</span>
        <input value={t} onChange={e => setT(e.target.value)} inputMode="numeric" placeholder="600"
          className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white" />
      </label>
      <button onClick={save} disabled={!dirty} className={SAVE_BTN(dirty)}>Save</button>
    </div>
  );
}

/** 触发区的 workflow 级 guidance 编辑器 */
function WorkflowGuidanceEditor({ defName, guidance, onEdit }: {
  defName: string;
  guidance?: string;
  onEdit: (name: string, patch: { stepId?: string; guidance?: string; timeout?: number }) => void;
}) {
  const [g, setG] = useState(guidance ?? '');
  useEffect(() => { setG(guidance ?? ''); }, [defName, guidance]);
  const dirty = g !== (guidance ?? '');
  return (
    <details className="mb-2">
      <summary className="text-[10px] text-gray-400 uppercase tracking-wide cursor-pointer">workflow guidance</summary>
      <textarea value={g} onChange={e => setG(e.target.value)} rows={2}
        className="w-full text-xs border border-gray-200 rounded px-2 py-1 bg-white font-mono mt-1" />
      <button onClick={() => onEdit(defName, { guidance: g })} disabled={!dirty} className={`${SAVE_BTN(dirty)} mt-1`}>Save</button>
    </details>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-1.5">
      <div className="text-[10px] text-gray-400 uppercase tracking-wide mb-0.5">{label}</div>
      {children}
    </div>
  );
}
