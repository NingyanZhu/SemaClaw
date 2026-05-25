/**
 * SessionStore — 会话历史查询（按 agent / workingDir 隔离）
 *
 * 职责：
 *   - 解析指定 agent (folder) 当前的 workingDir（读 workspace-state 文件）
 *   - 列出该 workingDir 桶里的历史 session（按 mtime 倒序）
 *   - 抽取每个 session 最后一条用户 query 作为预览
 *   - 判断指定 session 是否属于当前 workingDir 桶
 *
 * 历史文件位置由 sema-core 决定：
 *   ~/.sema/history/<projectSlug>/<YYYY-MM-DD>_<sessionId>.json
 *   projectSlug = projectPathToDirName(workingDir)
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getProjectHistoryDir } from 'sema-core';
import { config } from '../config';

export interface SessionSummary {
  sessionId: string;
  startedAt: string;       // YYYY-MM-DD（来自文件名前缀）
  mtime: Date;             // 最近一次写入时间
  lastUserQuery: string;   // 最后一条 user 消息（去包装、截断）
}

/**
 * 解析指定 agent 当前的 workingDir。
 * 优先读 workspace-state 文件（WorkspaceTool 切换后的目录），
 * 不存在则回落到 paths.workspaceDir/{folder}。
 */
export function getAgentCurrentWorkingDir(folder: string): string {
  const stateFile = path.join(os.homedir(), '.semaclaw', `workspace-state-${folder}.json`);
  try {
    if (fs.existsSync(stateFile)) {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const { currentDir } = JSON.parse(raw) as { currentDir?: string };
      if (currentDir) return currentDir;
    }
  } catch {
    // fall through
  }
  return path.resolve(config.paths.workspaceDir, folder);
}

/**
 * 列出指定 workingDir 桶下的 session（按 mtime 倒序，最多 limit 条）。
 */
export function listSessions(workingDir: string, limit = 10): SessionSummary[] {
  const dir = getProjectHistoryDir(workingDir);
  if (!fs.existsSync(dir)) return [];

  const fileRe = /^(\d{4}-\d{2}-\d{2})_([0-9a-f]{8})\.json$/i;
  const entries: { file: string; sessionId: string; startedAt: string; mtime: Date }[] = [];

  for (const f of fs.readdirSync(dir)) {
    const m = f.match(fileRe);
    if (!m) continue;
    try {
      const stat = fs.statSync(path.join(dir, f));
      entries.push({ file: f, startedAt: m[1], sessionId: m[2], mtime: stat.mtime });
    } catch {
      // skip unreadable
    }
  }

  entries.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const top = entries.slice(0, limit);

  return top.map(e => ({
    sessionId: e.sessionId,
    startedAt: e.startedAt,
    mtime: e.mtime,
    lastUserQuery: readLastUserQuery(path.join(dir, e.file)),
  }));
}

export interface TranscriptEntry {
  role: 'user' | 'assistant';
  senderName?: string;   // 群桥接消息可能带原始 sender
  text: string;
  index: number;          // 在 session 中的稳定顺序（用于前端去重 / key）
}

/**
 * 读取指定 session 的完整文本对话流，供前端刷新后回放。
 * 过滤掉：
 *   - tool_use / tool_result（仅 chat-style 文本）
 *   - 空文本块
 *   - sema-core 注入的合成消息（usage stub 等）
 * 群桥接的 <messages><message sender=...>...</message></messages> 会被拆成多条 user。
 */
export function loadSessionTranscript(workingDir: string, sessionId: string): TranscriptEntry[] {
  const dir = getProjectHistoryDir(workingDir);
  const suffix = `_${sessionId}.json`;
  let filePath: string | null = null;
  try {
    const f = fs.readdirSync(dir).find(name => name.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}_/.test(name));
    if (f) filePath = path.join(dir, f);
  } catch {
    return [];
  }
  if (!filePath) return [];

  let data: { messages?: HistoryMessage[] };
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return [];
  }
  const messages = data.messages ?? [];
  const out: TranscriptEntry[] = [];
  let idx = 0;

  for (const m of messages) {
    if (m.type === 'user') {
      if (m.toolUseResult) continue;
      const raw = extractText(m.message?.content);
      if (!raw) continue;
      for (const entry of expandUserText(raw)) {
        out.push({ role: 'user', senderName: entry.sender, text: entry.text, index: idx++ });
      }
    } else if (m.type === 'assistant') {
      const raw = extractText(m.message?.content);
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // 跳过 sema-core 的合成 stub（"(no content)" 等会被它写进 SYNTHETIC_ASSISTANT_MESSAGES）
      if (trimmed === '(no content)' || trimmed === 'API Error: Sender stopped early') continue;
      out.push({ role: 'assistant', text: trimmed, index: idx++ });
    }
  }
  return out;
}

/** 判断 sessionId 在当前 workingDir 桶下是否存在。 */
export function sessionExistsInWorkingDir(workingDir: string, sessionId: string): boolean {
  const dir = getProjectHistoryDir(workingDir);
  if (!fs.existsSync(dir)) return false;
  const suffix = `_${sessionId}.json`;
  try {
    return fs.readdirSync(dir).some(f => f.endsWith(suffix) && /^\d{4}-\d{2}-\d{2}_/.test(f));
  } catch {
    return false;
  }
}

// ===== 内部 =====

interface HistoryMessage {
  type: 'user' | 'assistant';
  message: { role: string; content: string | { type: string; text?: string }[] };
  toolUseResult?: unknown;
}

function readLastUserQuery(filePath: string): string {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { messages?: HistoryMessage[] };
    const messages = data.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.type !== 'user') continue;
      // 跳过 tool_result（agent 的工具回执也以 user role 出现）
      if (m.toolUseResult) continue;
      const text = extractText(m.message?.content);
      if (!text) continue;
      const cleaned = cleanPreview(text);
      if (cleaned) return truncate(cleaned, 60);
    }
    return '(无文本内容)';
  } catch {
    return '(读取失败)';
  }
}

function extractText(content: HistoryMessage['message']['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // 取所有 text 块拼接（一般只有一个）；忽略 tool_result/image 等
  return content
    .filter(b => b && b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('\n');
}

/**
 * 剥掉 prompt 自动包装：
 *   - <memory>...</memory>\n\n 前缀（AgentPool pre-retrieval 注入）
 *   - <messages>...<message sender=... >X</message>...</messages>（SessionBridge 桥接）
 *     取最后一个 <message> 的内文作为代表。
 */
function cleanPreview(text: string): string {
  let t = text.trim();

  // 去 <memory>...</memory> 前缀
  const memMatch = t.match(/^<memory>[\s\S]*?<\/memory>\s*/);
  if (memMatch) t = t.slice(memMatch[0].length);

  // SessionBridge 包装：取最后一个 <message> 内文
  const msgs = [...t.matchAll(/<message[^>]*>([\s\S]*?)<\/message>/g)];
  if (msgs.length > 0) {
    t = unescapeXml(msgs[msgs.length - 1][1]);
  }

  return t.trim().replace(/\s+/g, ' ');
}

/**
 * 处理一条 user 消息原文：
 *   - 剥 <memory>...</memory> 前缀
 *   - 若含 <messages>...<message sender="X">Y</message></messages>，按 message 拆成多条
 *   - 否则当成单条 user 文本返回
 */
function expandUserText(raw: string): { sender?: string; text: string }[] {
  let t = raw.trim();
  const memMatch = t.match(/^<memory>[\s\S]*?<\/memory>\s*/);
  if (memMatch) t = t.slice(memMatch[0].length).trim();

  const msgs = [...t.matchAll(/<message[^>]*\bsender="([^"]*)"[^>]*>([\s\S]*?)<\/message>/g)];
  if (msgs.length > 0) {
    return msgs.map(m => ({
      sender: unescapeXml(m[1]) || undefined,
      text: unescapeXml(m[2]).trim(),
    })).filter(e => e.text.length > 0);
  }

  return t ? [{ text: t }] : [];
}

function unescapeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .replace(/&amp;/g, '&');
}

/**
 * 头尾各保留一半 + 中间省略号。
 * 人写 prompt 习惯把指令放最前或最后（"帮我..." / "...谢谢"），
 * 单纯截前面会把末尾的指令丢掉。
 */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  // 留 1 字给 '…'；剩下平分给头尾，尾多余给头
  const budget = n - 1;
  const tailLen = Math.floor(budget / 2);
  const headLen = budget - tailLen;
  return s.slice(0, headLen) + '…' + s.slice(s.length - tailLen);
}
