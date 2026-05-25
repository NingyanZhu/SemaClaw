/**
 * CommandDispatcher — 管理命令解析与执行
 *
 * Channel 无关：被 MessageRouter 调用，所有接入渠道（Telegram / WS / Voice…）均可复用。
 *
 * 命令分两类：
 *   1. 任务管理命令（isAdmin 群组专用，dispatchCommand 处理）
 *      list_tasks, task_logs, pause_task, resume_task, cancel_task, del_task, help
 *   2. 会话管理命令（所有 agent 群组可用，dispatchSessionCommand 处理）
 *      list_sessions [n], resume_session <id>, new_session
 *
 * 前缀 / 可选，大小写不敏感，下划线/空格均可。
 */

import type { ScheduledTask, TaskRunLog, GroupBinding } from '../types';
import { getTasksByGroup, getTaskRunLogs, listAllTasks, updateTaskStatus, deleteTask, getTaskById, advanceTaskNextRun } from '../db/db';
import { computeNextRunOnResume } from '../scheduler/TaskScheduler';
import type { AgentPool } from '../agent/AgentPool';
import {
  getAgentCurrentWorkingDir,
  listSessions,
  sessionExistsInWorkingDir,
} from '../agent/SessionStore';

export const COMMANDS_HELP = [
  '📋 可用命令：',
  '  list_tasks [folder]       — 列出任务（可按群组 folder 筛选）',
  '  task_logs <taskId> [n]    — 查看最近 n 条执行日志（默认 20）',
  '  pause_task <taskId>       — 暂停任务',
  '  resume_task <taskId>      — 恢复任务',
  '  cancel_task <taskId>      — 取消任务（标记完成，保留记录）',
  '  del_task <taskId>         — 删除任务（彻底移除）',
  '  list_sessions [n]         — 列出当前 workspace 历史会话（默认 10）',
  '  resume_session <id>       — 恢复指定历史会话',
  '  new_session               — 开启新会话（清空当前上下文）',
  '  help                      — 显示此帮助',
].join('\n');

/** 会话命令执行上下文（由 MessageRouter 注入） */
export interface SessionCommandCtx {
  group: GroupBinding;
  agentPool: AgentPool;
}

/**
 * 尝试将 text 解析为任务管理命令并执行。
 * @returns 命令执行结果文本，或 null（不是命令，应交给 Agent 处理）
 */
export function dispatchCommand(text: string): string | null {
  const t = text.trim();

  if (/^\/?help$/i.test(t)) return COMMANDS_HELP;

  // list_tasks [folder]
  const listMatch = t.match(/^\/?list[_\s]tasks?(?:\s+(\S+))?$/i);
  if (listMatch) {
    const folder = listMatch[1];
    const tasks = folder ? getTasksByGroup(folder) : listAllTasks();
    return formatTaskList(tasks, folder);
  }

  // task_logs <taskId> [limit]
  const logsMatch = t.match(/^\/?task[_\s]logs?\s+(\S+)(?:\s+(\d+))?$/i);
  if (logsMatch) {
    const taskId = logsMatch[1];
    const limit = logsMatch[2] ? parseInt(logsMatch[2], 10) : 20;
    return formatTaskLogs(taskId, getTaskRunLogs(taskId, limit));
  }

  // pause_task / resume_task / cancel_task <taskId>
  const manageMatch = t.match(/^\/?(pause|resume|cancel)[_\s]task\s+(\S+)$/i);
  if (manageMatch) {
    const action = manageMatch[1].toLowerCase();
    const taskId = manageMatch[2];

    // resume 需要同时重置 next_run，避免沿用暂停前已过期的时间导致追赶风暴
    if (action === 'resume') {
      const task = getTaskById(taskId);
      if (!task) return `❌ 任务不存在: ${taskId}`;
      if (task.scheduleType === 'once') {
        return `⚠️ One-time tasks cannot be resumed. Cancel this task and create a new one instead.`;
      }
      advanceTaskNextRun(task.id, computeNextRunOnResume(task), 'active');
      return `✅ 任务 ${taskId} 已恢复`;
    }

    const statusMap: Record<string, ScheduledTask['status']> = {
      pause: 'paused', cancel: 'completed',
    };
    updateTaskStatus(taskId, statusMap[action]);
    const label = action === 'pause' ? '已暂停' : '已取消';
    return `✅ 任务 ${taskId} ${label}`;
  }

  // del_task <taskId>
  const delMatch = t.match(/^\/?del[_\s]task\s+(\S+)$/i);
  if (delMatch) {
    const taskId = delMatch[1];
    return deleteTask(taskId) ? `🗑️ 任务 ${taskId} 已删除` : `❌ 任务不存在: ${taskId}`;
  }

  return null;
}

// ===== 格式化 =====

function formatTaskList(tasks: ScheduledTask[], folder?: string): string {
  const title = folder
    ? `📋 任务列表 — ${folder}（${tasks.length} 个）`
    : `📋 所有任务（${tasks.length} 个）`;
  if (tasks.length === 0) return `${title}\n暂无任务`;

  const statusIcon = (s: string) => s === 'active' ? '🟢' : s === 'paused' ? '⏸' : '⏹';
  const lines = [title, ''];
  for (const t of tasks) {
    lines.push(`${statusIcon(t.status)} ${t.groupFolder} · ${t.contextMode}`);
    lines.push(`   ID: ${t.id}`);
    lines.push(`   计划: ${t.scheduleValue} (${t.scheduleType})`);
    const preview = t.prompt.length > 60 ? `${t.prompt.slice(0, 60)}…` : t.prompt;
    lines.push(`   内容: ${preview}`);
    if (t.nextRun) lines.push(`   下次: ${t.nextRun}`);
    if (t.lastRun)  lines.push(`   上次: ${t.lastRun}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/** 把 Date 格式化为本地时区的 "YYYY-MM-DD HH:MM"。 */
function formatLocalTime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ===== 会话命令 =====

/**
 * 尝试将 text 解析为会话管理命令并执行。
 * 所有 agent 群组可用（不限 isAdmin）。
 * @returns 命令执行结果文本，或 null（不是会话命令）
 */
export async function dispatchSessionCommand(
  text: string,
  ctx: SessionCommandCtx,
): Promise<string | null> {
  const t = text.trim();
  const { group, agentPool } = ctx;
  const workingDir = getAgentCurrentWorkingDir(group.folder);

  // list_sessions [n]
  const listMatch = t.match(/^\/?list[_\s]sessions?(?:\s+(\d+))?$/i);
  if (listMatch) {
    const n = listMatch[1] ? Math.max(1, Math.min(50, parseInt(listMatch[1], 10))) : 10;
    const sessions = listSessions(workingDir, n);
    if (sessions.length === 0) {
      return `📜 暂无历史会话\nagent: ${group.folder}\nworkspace: ${workingDir}`;
    }
    const lines = [
      `📜 历史会话（${sessions.length} 条）`,
      `agent: ${group.folder}`,
      `workspace: ${workingDir}`,
      '',
    ];
    sessions.forEach((s, i) => {
      const time = formatLocalTime(s.mtime);
      lines.push(`${i + 1}) ${s.sessionId}  ${time}`);
      lines.push(`   "${s.lastUserQuery}"`);
    });
    lines.push('');
    lines.push('用 resume_session <id> 恢复，new_session 开新会话');
    return lines.join('\n');
  }

  // resume_session <id>
  const resumeMatch = t.match(/^\/?resume[_\s]session\s+([0-9a-f]{8})$/i);
  if (resumeMatch) {
    const sid = resumeMatch[1].toLowerCase();
    if (!sessionExistsInWorkingDir(workingDir, sid)) {
      return `❌ 当前 workspace 下找不到会话 ${sid}\nworkspace: ${workingDir}\n用 list_sessions 查看可用会话`;
    }
    agentPool.setPendingResume(group.jid, sid);
    try {
      await agentPool.destroy(group.jid);
    } catch (e) {
      // destroy 失败不致命，下次 getOrCreate 仍会读取 pendingResume
      console.warn(`[SessionCommand] destroy failed (will resume on next msg): ${e}`);
    }
    return `✅ 已切到会话 ${sid}，发任意消息继续上下文\nworkspace: ${workingDir}`;
  }

  // new_session
  if (/^\/?new[_\s]session$/i.test(t)) {
    agentPool.clearPendingResume(group.jid);
    try {
      await agentPool.destroy(group.jid);
    } catch (e) {
      console.warn(`[SessionCommand] destroy failed: ${e}`);
    }
    return `✅ 已开启新会话，发任意消息开始\nworkspace: ${workingDir}`;
  }

  return null;
}

function formatTaskLogs(taskId: string, logs: TaskRunLog[]): string {
  if (logs.length === 0) return `📜 任务 ${taskId} 暂无执行记录`;
  const lines = [`📜 执行日志 — ${taskId}（最近 ${logs.length} 条）`, ''];
  for (const log of logs) {
    const icon = log.status === 'success' ? '✅' : '❌';
    lines.push(`${icon} ${log.runAt}${log.durationMs !== null ? `  (${log.durationMs}ms)` : ''}`);
    if (log.result) {
      const p = log.result.length > 120 ? `${log.result.slice(0, 120)}…` : log.result;
      lines.push(`   ${p}`);
    }
    if (log.error) lines.push(`   错误: ${log.error.slice(0, 120)}`);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}
