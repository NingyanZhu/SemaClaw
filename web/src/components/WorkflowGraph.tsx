import { useMemo } from 'react';
import type { WorkflowStepRun, WfStepStatus } from '../types';

/**
 * WorkflowGraph — 竖向分层 DAG（无图布局库）
 *
 * 布局逻辑（dev-plans/workflow-feature.md §8）：
 *   rank(node) = 最长依赖深度 → 同 rank 一行（入口 rank=0 在顶），依赖沿 dependsOn 向下；
 *   行内横向均分，SVG 竖线连接。适配窄高面板（viewBox 等比缩放）。
 */

interface Props {
  steps: WorkflowStepRun[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const VBW = 320;          // 虚拟视口宽
const ROW_GAP = 62;       // 行间距
const NODE_H = 30;
const TOP = 14;

const STATUS_STYLE: Record<WfStepStatus, { fill: string; stroke: string; text: string; dash?: string }> = {
  pending: { fill: '#F3F4F6', stroke: '#D1D5DB', text: '#9CA3AF' },
  running: { fill: '#EBF5FB', stroke: '#5BBFE8', text: '#2A7BAA' },
  done:    { fill: '#ECFDF5', stroke: '#34D399', text: '#047857' },
  failed:  { fill: '#FEF2F2', stroke: '#F87171', text: '#B91C1C' },
  skipped: { fill: '#F9FAFB', stroke: '#E5E7EB', text: '#C0C5CC', dash: '3 3' },
};

export function WorkflowGraph({ steps, selectedId, onSelect }: Props) {
  const layout = useMemo(() => computeLayout(steps), [steps]);
  if (steps.length === 0) return null;

  return (
    <svg
      viewBox={`0 0 ${VBW} ${layout.height}`}
      width="100%"
      preserveAspectRatio="xMidYMin meet"
      style={{ maxHeight: layout.height }}
      className="select-none"
    >
      {/* edges */}
      {layout.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="#CBD5E1" strokeWidth={1.4} />
      ))}
      {/* nodes */}
      {layout.nodes.map(n => {
        const st = STATUS_STYLE[n.step.status];
        const selected = n.step.id === selectedId;
        return (
          <g key={n.step.id} transform={`translate(${n.x},${n.y})`}
            onClick={() => onSelect(n.step.id)} style={{ cursor: 'pointer' }}>
            <rect
              width={n.w} height={NODE_H} rx={6}
              fill={st.fill}
              stroke={selected ? '#3B82F6' : st.stroke}
              strokeWidth={selected ? 2.2 : 1.3}
              strokeDasharray={st.dash}
              className={n.step.status === 'running' ? 'animate-pulse' : undefined}
            />
            <text x={8} y={NODE_H / 2 + 1} dominantBaseline="middle"
              fontSize={11} fill={st.text} fontWeight={600}>
              {n.step.kind === 'agent' ? '◆' : '▸'} {truncate(n.step.id, n.w)}
            </text>
            {n.step.kind === 'agent' && n.step.persona && (
              <text x={n.w / 2} y={NODE_H + 10} textAnchor="middle"
                fontSize={9} fill="#94A3B8">
                {truncate(n.step.persona, n.w + 28)}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

// ===== layout =====

interface PlacedNode { step: WorkflowStepRun; x: number; y: number; w: number; }
interface Edge { x1: number; y1: number; x2: number; y2: number; }

function computeLayout(steps: WorkflowStepRun[]): { nodes: PlacedNode[]; edges: Edge[]; height: number } {
  const byId = new Map(steps.map(s => [s.id, s]));
  const rankCache = new Map<string, number>();

  const rank = (id: string, seen: Set<string> = new Set()): number => {
    if (rankCache.has(id)) return rankCache.get(id)!;
    if (seen.has(id)) return 0;               // 防御环（registry 已校验无环）
    seen.add(id);
    const deps = (byId.get(id)?.dependsOn ?? []).filter(d => byId.has(d));
    const r = deps.length === 0 ? 0 : 1 + Math.max(...deps.map(d => rank(d, seen)));
    rankCache.set(id, r);
    return r;
  };

  // group by rank
  const rows: WorkflowStepRun[][] = [];
  for (const s of steps) {
    const r = rank(s.id);
    (rows[r] ??= []).push(s);
  }

  const center = new Map<string, { cx: number; cy: number; w: number }>();
  const nodes: PlacedNode[] = [];
  rows.forEach((row, r) => {
    const L = row.length;
    const w = Math.max(56, Math.min(110, Math.floor(VBW / L) - 10));
    row.forEach((step, c) => {
      const cx = ((c + 0.5) / L) * VBW;
      const y = TOP + r * ROW_GAP;
      const x = cx - w / 2;
      nodes.push({ step, x, y, w });
      center.set(step.id, { cx, cy: y, w });
    });
  });

  const edges: Edge[] = [];
  for (const s of steps) {
    const childC = center.get(s.id);
    if (!childC) continue;
    for (const dep of s.dependsOn ?? []) {
      const depC = center.get(dep);
      if (!depC) continue;
      edges.push({ x1: depC.cx, y1: depC.cy + NODE_H, x2: childC.cx, y2: childC.cy });
    }
  }

  // +16 给 agent 节点下方的 persona 副标题留出空间
  const height = TOP + rows.length * ROW_GAP - (ROW_GAP - NODE_H) + 16;
  return { nodes, edges, height };
}

function truncate(s: string, w: number): string {
  const max = Math.max(4, Math.floor((w - 18) / 6.2));
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
