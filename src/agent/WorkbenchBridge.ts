/**
 * WorkbenchBridge — 将 sema-core 的工作台事件中继到前端 / 聊天 channel
 *
 * 职责：
 *   1. 监听 `workbench:new` / `workbench:service_ready/crashed/stopped` 4 个事件
 *      → 通过注入的 onXxx 回调把数据推给 WsGateway（前端 webui 渲染面板）
 *      → 同时向非 web 聊天 channel 发一条文本通知（"📁 已生成工作台 X，路径 Y"）
 *   2. 反向操作：用户在 webui 里点 close / markViewed / 查看日志 / 读源文件时
 *      → WsGateway 调 AgentPool 的方法 → 这里转给对应 core.workbenchService
 *
 * 与 PermissionBridge 的差异：
 *   - 没有 pending 状态：sema-core 端事件是 fire-and-forget
 *   - 没有 callback_query：IM channel 上不放按钮，只发文字通知
 *   - 反向操作直接调用 core 方法（不走事件回路）
 */

import { SemaCore } from 'sema-core';
import type {
  WorkbenchNewData,
  WorkbenchServiceReadyData,
  WorkbenchServiceCrashedData,
  WorkbenchServiceStoppedData,
  WorkbenchArtifact,
} from 'sema-core/event';
import type { IChannel, GroupBinding } from '../types';

// ===== 对外 payload 类型（前端订阅） =====

export interface WorkbenchNewPayload {
  artifact: WorkbenchArtifact;
  replacesId: string | null;
}

export interface WorkbenchServiceReadyPayload {
  artifactId: string;
  ready: boolean;
}

export interface WorkbenchServiceCrashedPayload {
  artifactId: string;
  lastLogLines: string;
}

export interface WorkbenchServiceStoppedPayload {
  artifactId: string;
  reason: 'manual' | 'idle' | 'session_end';
}

// ===== Bridge =====

export class WorkbenchBridge {
  /** chatJid → SemaCore（反向方法用） */
  private cores = new Map<string, SemaCore>();

  /** 4 个回调注入点（由 AgentPool 接入 WsGateway sink） */
  private onNewCb?: (chatJid: string, payload: WorkbenchNewPayload) => void;
  private onServiceReadyCb?: (chatJid: string, payload: WorkbenchServiceReadyPayload) => void;
  private onServiceCrashedCb?: (chatJid: string, payload: WorkbenchServiceCrashedPayload) => void;
  private onServiceStoppedCb?: (chatJid: string, payload: WorkbenchServiceStoppedPayload) => void;

  private readonly channels: IChannel[];

  constructor(channels: IChannel | IChannel[]) {
    this.channels = Array.isArray(channels) ? channels : [channels];
  }

  // ===== 注入点 =====

  onNew(fn: (chatJid: string, payload: WorkbenchNewPayload) => void): void {
    this.onNewCb = fn;
  }
  onServiceReady(fn: (chatJid: string, payload: WorkbenchServiceReadyPayload) => void): void {
    this.onServiceReadyCb = fn;
  }
  onServiceCrashed(fn: (chatJid: string, payload: WorkbenchServiceCrashedPayload) => void): void {
    this.onServiceCrashedCb = fn;
  }
  onServiceStopped(fn: (chatJid: string, payload: WorkbenchServiceStoppedPayload) => void): void {
    this.onServiceStoppedCb = fn;
  }

  // ===== 绑定 core =====

  /**
   * 将指定 SemaCore 的工作台事件接入此 bridge。
   * AgentPool.getOrCreate() 中为每个 core 调用一次。
   * 返回清理函数，destroy 时调用以移除监听器。
   */
  bindCore(core: SemaCore, binding: GroupBinding): () => void {
    const chatJid = binding.jid;
    const botToken = binding.botToken ?? undefined;
    this.cores.set(chatJid, core);

    const handleNew = (data: WorkbenchNewData) => {
      this.handleNew(data, chatJid, botToken).catch(err =>
        console.error('[WorkbenchBridge] handleNew error:', err),
      );
    };
    const handleReady = (data: WorkbenchServiceReadyData) => {
      this.onServiceReadyCb?.(chatJid, { artifactId: data.artifactId, ready: data.ready });
    };
    const handleCrashed = (data: WorkbenchServiceCrashedData) => {
      this.onServiceCrashedCb?.(chatJid, {
        artifactId: data.artifactId,
        lastLogLines: data.lastLogLines,
      });
    };
    const handleStopped = (data: WorkbenchServiceStoppedData) => {
      this.onServiceStoppedCb?.(chatJid, { artifactId: data.artifactId, reason: data.reason });
    };

    core.on<WorkbenchNewData>('workbench:new', handleNew);
    core.on<WorkbenchServiceReadyData>('workbench:service_ready', handleReady);
    core.on<WorkbenchServiceCrashedData>('workbench:service_crashed', handleCrashed);
    core.on<WorkbenchServiceStoppedData>('workbench:service_stopped', handleStopped);

    return () => {
      core.off('workbench:new', handleNew);
      core.off('workbench:service_ready', handleReady);
      core.off('workbench:service_crashed', handleCrashed);
      core.off('workbench:service_stopped', handleStopped);
      this.cores.delete(chatJid);
    };
  }

  // ===== 反向操作（由 AgentPool.resolveXxx 转入） =====

  /** 用户在 webui 切到某工作台前台 → 更新 last_active（仅 service 类有效） */
  markViewed(chatJid: string, artifactId: string): boolean {
    const core = this.cores.get(chatJid);
    if (!core) return false;
    core.workbenchService.markViewed(artifactId);
    return true;
  }

  /** 用户关闭工作台 → 杀进程（service 类）+ 移出历史 */
  async close(chatJid: string, artifactId: string): Promise<boolean> {
    const core = this.cores.get(chatJid);
    if (!core) return false;
    await core.workbenchService.close(artifactId);
    return true;
  }

  /** 前端代读 artifact 文件内容（用于 markdown / html 渲染） */
  async readFile(
    chatJid: string,
    artifactId: string,
    filePath: string,
  ): Promise<{ content?: string; error?: string }> {
    const core = this.cores.get(chatJid);
    if (!core) return { error: 'core_not_found' };
    return core.workbenchService.readFile(artifactId, filePath);
  }

  /** 取 service 类工作台的最近日志 */
  async fetchLogs(chatJid: string, artifactId: string, tailLines: number): Promise<string> {
    const core = this.cores.get(chatJid);
    if (!core) return '';
    return core.workbenchService.fetchLogs(artifactId, tailLines);
  }

  // ===== 内部：处理 workbench:new =====

  /**
   * webui 端：推给 WsGateway broadcast
   * 非 web channel：发一条文本通知，让用户知道有产物可看
   */
  private async handleNew(
    data: WorkbenchNewData,
    chatJid: string,
    botToken?: string,
  ): Promise<void> {
    // 1) 推给前端
    this.onNewCb?.(chatJid, { artifact: data.artifact, replacesId: data.replacesId });

    // 2) 非 web channel 文本降级通知
    if (!chatJid.startsWith('web:')) {
      const channel = this.channels.find(ch => ch.ownsJid(chatJid));
      if (channel) {
        try {
          await channel.sendMessage(chatJid, formatChannelNotice(data.artifact), botToken);
        } catch (err) {
          console.warn(
            `[WorkbenchBridge] channel notify failed for ${chatJid}:`,
            (err as Error).message,
          );
        }
      }
    }
  }
}

// ===== helpers =====

function formatChannelNotice(artifact: WorkbenchArtifact): string {
  const lines: string[] = [`📁 工作台：${artifact.title}`];
  if (artifact.mode === 'static' && artifact.files?.length) {
    if (artifact.files.length === 1) {
      lines.push(`文件：${artifact.files[0].path}`);
    } else {
      lines.push(`${artifact.files.length} 个文件：`);
      for (const f of artifact.files) lines.push(`• ${f.path}`);
    }
  } else if (artifact.url) {
    lines.push(`URL：${artifact.url}`);
  }
  lines.push('（在 webui 端查看完整呈现）');
  return lines.join('\n');
}
