import type { DispatchParent, AgentTodosEntry, ChatMessage, GroupInfo, PermissionMessage, WorkbenchState, WorkflowRun } from '../types';
import { useMemo } from 'react';

type DockKind = 'agent' | 'workbench' | 'workflow';

interface Props {
  expanded: DockKind | null;
  onToggle: (which: DockKind) => void;
  // AgentConsole badge data
  dispatchParents: DispatchParent[];
  agentTodos: Record<string, AgentTodosEntry>;
  messages: Record<string, ChatMessage[]>;
  groups: GroupInfo[];
  // Workbench badge data
  workbenchState: WorkbenchState | null;
  // Workflow badge data
  workflowRuns: WorkflowRun[];
}

export function DockBadges(p: Props) {
  // ===== AgentConsole 信号 =====
  const pendingPermissions = useMemo(() => {
    let n = 0;
    for (const msgs of Object.values(p.messages)) {
      for (const m of msgs) {
        if (m.role === 'permission' && !(m as PermissionMessage).resolved) n++;
      }
    }
    return n;
  }, [p.messages]);
  const hasActivity = p.dispatchParents.some(d => d.status === 'active' || d.status === 'queued');
  const hasTodos = Object.keys(p.agentTodos).length > 0;
  void p.groups; // 仅签名一致，留作日后定向跳转用

  // ===== Workbench 信号 =====
  const wbCurrent = p.workbenchState?.current ?? null;
  const wbHasRunning = p.workbenchState?.history.some(h => h.process?.status === 'running') ?? false;

  // ===== Workflow 信号 =====
  const wfRunning = p.workflowRuns.some(r => r.status === 'running');
  const wfHasRuns = p.workflowRuns.length > 0;

  return (
    <div className="flex flex-col items-center gap-3 w-10 flex-shrink-0 border-l border-gray-100 py-3 bg-white">
      <BadgeButton
        active={p.expanded === 'agent'}
        onClick={() => p.onToggle('agent')}
        title="Agent Console"
        icon={<GearIcon />}
        countBadge={pendingPermissions > 0 ? pendingPermissions : null}
        dot={hasActivity ? 'live' : hasTodos ? 'info' : null}
      />
      <BadgeButton
        active={p.expanded === 'workbench'}
        onClick={() => p.onToggle('workbench')}
        title="Workbench"
        icon={<MonitorIcon />}
        countBadge={null}
        dot={wbCurrent ? 'info' : wbHasRunning ? 'live' : null}
      />
      <BadgeButton
        active={p.expanded === 'workflow'}
        onClick={() => p.onToggle('workflow')}
        title="Workflow"
        icon={<FlowIcon />}
        countBadge={null}
        dot={wfRunning ? 'live' : wfHasRuns ? 'info' : null}
      />
    </div>
  );
}

interface BadgeButtonProps {
  active: boolean;
  onClick: () => void;
  title: string;
  icon: React.ReactNode;
  countBadge: number | null;
  /** 状态点：'live' = 绿色脉冲；'info' = 蓝色静态 */
  dot: 'live' | 'info' | null;
}

function BadgeButton({ active, onClick, title, icon, countBadge, dot }: BadgeButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`relative flex flex-col items-center gap-1 w-7 h-7 justify-center rounded transition-colors ${
        active
          ? 'text-[#5BBFE8] bg-[#EBF5FB]'
          : 'text-gray-400 hover:text-[#5BBFE8]'
      }`}
    >
      {icon}
      {countBadge != null && (
        <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] px-1 rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center">
          {countBadge}
        </span>
      )}
      {dot === 'live' && (
        <span className="absolute -bottom-0.5 w-1.5 h-1.5 rounded-full bg-green-500 animate-pulse" />
      )}
      {dot === 'info' && (
        <span className="absolute -bottom-0.5 w-1.5 h-1.5 rounded-full bg-[#5BBFE8]" />
      )}
    </button>
  );
}

// ===== Icons（与 gear 同视觉重量：16x16 stroke 1.8） =====

function GearIcon() {
  // 用现有 unicode gear 保持原视觉
  return <span className="text-base leading-none select-none">⚙</span>;
}

function MonitorIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="13" rx="1.2" />
      <path d="M9 21h6" />
      <path d="M12 17v4" />
    </svg>
  );
}

function FlowIcon() {
  // 竖向分层 DAG 缩影：顶部两节点并行 → 汇聚到底部一个
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="8.5" y="16" width="7" height="5" rx="1" />
      <path d="M6.5 8v3.5h11V8" />
      <path d="M12 11.5V16" />
    </svg>
  );
}
