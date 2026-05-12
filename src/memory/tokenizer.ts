/**
 * 分词工具（独立模块，避免 fts-search ↔ query-rewrite 循环依赖）
 */

import { filterStopwords } from './stopwords';

// @node-rs/jieba 是预编译的 napi 模块，全平台都有 prebuilt，几乎不会装失败。
// 仍保留懒加载 + try-catch，万一拉不到 native binary 时降级为字符级分词，避免整个模块崩。
// undefined = 未尝试加载；null = 加载失败；其他 = 加载成功
let jiebaInstance: { cut: (text: string) => string[] } | null | undefined = undefined;

function getJieba(): { cut: (text: string) => string[] } | null {
  if (jiebaInstance === undefined) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { Jieba } = require('@node-rs/jieba') as { Jieba: { withDict: (d: Uint8Array) => { cut: (s: string, hmm?: boolean) => string[] } } };
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { dict } = require('@node-rs/jieba/dict') as { dict: Uint8Array };
      const jieba = Jieba.withDict(dict);
      jiebaInstance = { cut: (text: string) => jieba.cut(text, true) };
    } catch {
      console.warn('[Tokenizer] @node-rs/jieba not available, falling back to character-level segmentation.');
      jiebaInstance = null;
    }
  }
  return jiebaInstance;
}

/**
 * 中文字符级 fallback 分词（@node-rs/jieba 不可用时使用）。
 * 将连续中文字符串拆成单字，并生成 2-gram，保证基本的 FTS 匹配能力。
 */
function cutChineseFallback(segment: string): string[] {
  const chars = segment.split('');
  const tokens: string[] = [...chars];
  for (let i = 0; i < chars.length - 1; i++) {
    tokens.push(chars[i] + chars[i + 1]);
  }
  return tokens;
}

/**
 * 智能分词（支持中英混合 + 停用词过滤）
 *
 * - 中文：优先使用 Jieba 分词；@node-rs/jieba 不可用时降级为字符级分词
 * - 英文：按空格和标点分词
 * - 混合：分别处理后合并
 * - 停用词：自动过滤无意义词
 */
export function tokenizeOptimized(text: string, removeStopwords = true): string[] {
  if (!text || text.trim().length === 0) return [];

  const tokens: string[] = [];
  const jieba = getJieba();

  // 1. 提取中文部分，使用 Jieba 分词（或 fallback）
  const chineseText = text.match(/[\u4e00-\u9fff]+/g);
  if (chineseText) {
    for (const segment of chineseText) {
      const chineseTokens = jieba ? jieba.cut(segment) : cutChineseFallback(segment);
      tokens.push(...chineseTokens.filter(t => t.length > 0).map(t => t.toLowerCase()));
    }
  }

  // 2. 提取英文部分，按空格和标点分词
  const nonChineseText = text.replace(/[\u4e00-\u9fff]+/g, ' ');
  const englishTokens = nonChineseText
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter(t => t.length > 0 && /[a-z0-9]/.test(t));

  tokens.push(...englishTokens);

  // 3. 去重
  const uniqueTokens = [...new Set(tokens)];

  // 4. 过滤停用词（可选）
  if (removeStopwords) {
    return filterStopwords(uniqueTokens);
  }

  return uniqueTokens;
}

/**
 * 生成 2-gram tokens（用于 Keyword Fallback）
 */
export function generate2gram(text: string): string[] {
  const chars = text.match(/[\u4e00-\u9fff]/g) || [];
  const ngrams: string[] = [];

  for (let i = 0; i < chars.length - 1; i++) {
    ngrams.push(chars[i] + chars[i + 1]);
  }

  return ngrams;
}
