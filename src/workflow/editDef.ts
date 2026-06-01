/**
 * editDef — 无损编辑 workflow 定义的 frontmatter
 *
 * 见 dev-plans/workflow-feature.md §8（dock 可编辑 workflow.guidance / step.guidance / step.timeout）。
 *
 * 用 yaml(eemeli) 的 Document API：parse→改单个节点→stringify，**保留注释/格式/键顺序**。
 * 只动 frontmatter（--- ... ---）那段，正文与 frontmatter 之外的内容原样保留。
 * 单一真相源 = .md 文件本身，不引入 overlay。
 */

import * as fs from 'fs';
import { parseDocument, Scalar, type YAMLMap, type YAMLSeq } from 'yaml';

export interface EditPatch {
  /** 不传 = 编辑 workflow 级 guidance；传 = 编辑该 step */
  stepId?: string;
  /** 新 guidance（'' 或仅空白 = 删除该字段） */
  guidance?: string;
  /** 新 timeout 秒（仅 step 级有效；undefined = 不动） */
  timeout?: number;
}

/** 就地编辑文件。成功返回 true，失败抛错。 */
export function editWorkflowFile(filePath: string, patch: EditPatch): void {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const lines = raw.split('\n');

  // 定位 frontmatter 边界
  let start = -1, end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) start = i;
      else { end = i; break; }
    }
  }
  if (start === -1 || end === -1) throw new Error('no frontmatter to edit');

  const fmText = lines.slice(start + 1, end).join('\n');
  const doc = parseDocument(fmText);

  if (patch.stepId === undefined) {
    // workflow 级 guidance
    applyGuidance(doc as unknown as YAMLMap, 'guidance', patch.guidance);
  } else {
    const steps = doc.get('steps') as YAMLSeq | undefined;
    if (!steps || !Array.isArray(steps.items)) throw new Error('no steps in definition');
    const stepMap = steps.items.find(
      (it): it is YAMLMap => isMap(it) && it.get('id') === patch.stepId,
    );
    if (!stepMap) throw new Error(`step "${patch.stepId}" not found`);
    if (patch.guidance !== undefined) applyGuidance(stepMap, 'guidance', patch.guidance);
    if (patch.timeout !== undefined) {
      if (!Number.isFinite(patch.timeout) || patch.timeout <= 0) throw new Error('timeout must be a positive number');
      stepMap.set('timeout', Math.floor(patch.timeout));
    }
  }

  // 重组：frontmatter 段替换为新内容（doc.toString 末尾带换行，去掉以免多空行）
  const newFm = doc.toString().replace(/\n+$/, '');
  const rebuilt = [
    ...lines.slice(0, start + 1),
    ...newFm.split('\n'),
    ...lines.slice(end),
  ].join('\n');

  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, rebuilt, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/** 设/删 guidance：多行用块字面量(|)更易读；空白则删除该键 */
function applyGuidance(map: YAMLMap, key: string, value: string | undefined): void {
  if (value === undefined) return;
  if (value.trim() === '') {
    map.delete(key);
    return;
  }
  const node = new Scalar(value);
  if (value.includes('\n')) node.type = Scalar.BLOCK_LITERAL;
  map.set(key, node);
}

function isMap(it: unknown): it is YAMLMap {
  return !!it && typeof (it as { get?: unknown }).get === 'function' && 'items' in (it as object);
}
