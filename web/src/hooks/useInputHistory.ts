import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Shell-style input history（per-jid，最多 10 条，localStorage 持久化）。
 *
 * 行为：
 *   - 在 textarea 上按 ArrowUp/Down 触发；只在 caret 处于首/末时触发（不打断多行编辑）
 *   - ArrowUp 第一次：保存当前未发送的草稿，弹出最近一条
 *   - 继续 ArrowUp：往更早的条目
 *   - ArrowDown：回到更新的条目；到底回到保存的草稿
 *   - push(text)：发送时调用；去重连续重复条目；超出 cap 丢最旧
 *   - 任何手动修改输入框（onChange）→ 调 resetCursor() 取消导航态
 */

const STORAGE_PREFIX = 'semaclaw:input-history:v1:';
const CAP = 10;

function loadHistory(jid: string): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + jid);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(s => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveHistory(jid: string, list: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_PREFIX + jid, JSON.stringify(list));
  } catch {
    /* quota / private mode */
  }
}

export interface InputHistory {
  /** 把刚发送的文本压入历史（连续重复会去重） */
  push: (text: string) => void;
  /** ArrowUp：返回上一条；undefined 表示已到顶/无历史 */
  recallPrev: (currentInput: string) => string | undefined;
  /** ArrowDown：返回下一条；undefined 表示已到底回到草稿 */
  recallNext: () => string | undefined;
  /** 用户手动修改输入框时调用，重置导航 cursor */
  resetCursor: () => void;
}

export function useInputHistory(jid: string | null): InputHistory {
  const [history, setHistory] = useState<string[]>([]);
  // cursor: -1 = not navigating；0 = 最新一条；length-1 = 最旧
  const cursorRef = useRef<number>(-1);
  // 进入导航前保存的草稿，用于 ArrowDown 回到底时还原
  const draftRef = useRef<string>('');

  // jid 切换时重新加载历史
  useEffect(() => {
    if (jid) {
      setHistory(loadHistory(jid));
    } else {
      setHistory([]);
    }
    cursorRef.current = -1;
    draftRef.current = '';
  }, [jid]);

  const push = useCallback((text: string) => {
    if (!jid) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    setHistory(prev => {
      // 与最新一条相同时不重复入栈
      if (prev[0] === trimmed) return prev;
      const next = [trimmed, ...prev.filter(t => t !== trimmed)].slice(0, CAP);
      saveHistory(jid, next);
      return next;
    });
    cursorRef.current = -1;
    draftRef.current = '';
  }, [jid]);

  const recallPrev = useCallback((currentInput: string): string | undefined => {
    if (history.length === 0) return undefined;
    if (cursorRef.current === -1) {
      // 第一次按 ArrowUp，记下草稿
      draftRef.current = currentInput;
      cursorRef.current = 0;
      return history[0];
    }
    if (cursorRef.current >= history.length - 1) {
      // 已到最旧
      return undefined;
    }
    cursorRef.current += 1;
    return history[cursorRef.current];
  }, [history]);

  const recallNext = useCallback((): string | undefined => {
    if (cursorRef.current <= 0) {
      // 回到草稿
      if (cursorRef.current === 0) {
        cursorRef.current = -1;
        return draftRef.current;
      }
      return undefined;
    }
    cursorRef.current -= 1;
    return history[cursorRef.current];
  }, [history]);

  const resetCursor = useCallback(() => {
    cursorRef.current = -1;
  }, []);

  return { push, recallPrev, recallNext, resetCursor };
}
