/**
 * buildSkillsExtraDirs — 为隔离 session 构建 skillsExtraDirs
 *
 * 逻辑抽自 VirtualWorkerPool.ts:128-136，使 workflow 的 agent step 与虚拟 agent 看到同一套 skills
 * （bundled + ~/.claude/skills + managed + workspace），并过滤 disabled。
 *
 * 注：VirtualWorkerPool 暂未改用本 helper（避免本次改动面扩散），后续可统一。
 */

import * as os from 'os';
import * as path from 'path';
import type { SemaCoreConfig } from 'sema-core/types';
import { config } from '../config';
import { readDisabledSkills } from '../skills/disabled';
import { expandSkillsDir } from '../skills/expand';

export function buildSkillsExtraDirs(workspaceDir: string): SemaCoreConfig['skillsExtraDirs'] {
  const disabled = readDisabledSkills();
  return [
    ...(config.paths.bundledSkillsDir
      ? expandSkillsDir(config.paths.bundledSkillsDir, 'managed', disabled)
      : []),
    ...expandSkillsDir(path.join(os.homedir(), '.claude', 'skills'), 'user', disabled),
    ...expandSkillsDir(config.paths.managedSkillsDir, 'managed', disabled),
    ...expandSkillsDir(path.join(workspaceDir, 'skills'), 'workspace', disabled),
  ];
}
