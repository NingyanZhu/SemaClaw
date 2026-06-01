import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import * as dotenv from 'dotenv';


dotenv.config();

const home = os.homedir();

const envOptional = (key: string, fallback: string): string =>
  process.env[key] ?? fallback;

const envInt = (key: string, fallback: number): number =>
  parseInt(process.env[key] ?? String(fallback), 10);

// ============================================================
// 根目录解析
//
// 两个总开关：
//   SEMACLAW_HOME         → 运行数据根  (默认 ~/semaclaw)
//   SEMACLAW_CONFIG_HOME  → 配置/状态根 (默认 ~/.semaclaw)
//
// 优先级：细粒度 env > 总开关 env > config.json > 默认值
//
// 注意 SEMACLAW_CONFIG_HOME 只能来自 env —— config.json 本身就在它下面，
// 鸡生蛋问题。WebUI 编辑 configHome 只能写到现有 config.json 里供下次启动
// 参考，实际生效仍以 env 为准。
// ============================================================

const SEMACLAW_HOME_DEFAULT = path.join(home, 'semaclaw');
const SEMACLAW_CONFIG_HOME_DEFAULT = path.join(home, '.semaclaw');

const semaclawConfigHome = path.resolve(
  envOptional('SEMACLAW_CONFIG_HOME', SEMACLAW_CONFIG_HOME_DEFAULT)
);

const globalConfigPath = path.resolve(
  envOptional('SEMACLAW_CONFIG_PATH', path.join(semaclawConfigHome, 'config.json'))
);

/** 启动期从 config.json 读 paths.home，作为 SEMACLAW_HOME 未设时的回落值。 */
function readHomeFromConfigJson(): string | undefined {
  try {
    if (!fs.existsSync(globalConfigPath)) return undefined;
    const raw = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8')) as { paths?: { home?: unknown } };
    const v = raw?.paths?.home;
    return typeof v === 'string' && v.trim() ? path.resolve(v) : undefined;
  } catch {
    return undefined;
  }
}

const semaclawHome = process.env.SEMACLAW_HOME
  ? path.resolve(process.env.SEMACLAW_HOME)
  : (readHomeFromConfigJson() ?? SEMACLAW_HOME_DEFAULT);

export const config = {
  telegram: {
    botToken: envOptional('TELEGRAM_BOT_TOKEN', ''),
    /** 主 Bot 绑定的 agent folder（默认 main） */
    agentFolder: envOptional('TELEGRAM_AGENT_FOLDER', 'main'),
  },

  feishu: {
    appId: envOptional('FEISHU_APP_ID', ''),
    appSecret: envOptional('FEISHU_APP_SECRET', ''),
    domain: envOptional('FEISHU_DOMAIN', 'feishu'),
  },

  qq: {
    appId: envOptional('QQ_APP_ID', ''),
    appSecret: envOptional('QQ_APP_SECRET', ''),
    /** true = 沙箱环境（QQ 开放平台测试用） */
    sandbox: envOptional('QQ_SANDBOX', 'false') === 'true',
  },

  wechat: {
    /** true = 启用微信 iLink Bot 频道 */
    enabled: envOptional('WECHAT_ENABLED', 'false') === 'true',
    /** iLink API base URL，通常无需修改 */
    apiBaseUrl: envOptional('WECHAT_API_BASE_URL', 'https://ilinkai.weixin.qq.com'),
    /** 绑定到哪个 agent folder（默认 main） */
    agentFolder: envOptional('WECHAT_AGENT_FOLDER', 'main'),
  },

  admin: {
    telegramUserId: envOptional('ADMIN_TELEGRAM_USER_ID', ''),
    feishuOpenId: envOptional('ADMIN_FEISHU_OPEN_ID', ''),
  },

  agent: {
    maxConcurrent: envInt('MAX_CONCURRENT_AGENTS', 5),
    maxMessagesPerGroup: envInt('MAX_MESSAGES_PER_GROUP', 100),
  },

  scheduler: {
    intervalSec: envInt('SCHEDULER_INTERVAL_SEC', 60),
    /** notify 模式任务：超过此时长（分钟）未发出则丢弃，避免机器重启后发出过期通知 */
    notifyMaxDelayMinutes: envInt('NOTIFY_MAX_DELAY_MINUTES', 30),
  },

  paths: {
    /**
     * 运行数据根：~/semaclaw (默认)
     * 派生：agentsDir / workspaceDir / wikiDir / virtualAgentsDir
     */
    home: semaclawHome,
    /**
     * 配置/状态根：~/.semaclaw (默认)
     * 派生：dbPath / globalConfigPath / dispatchStatePath / managedSkillsDir / modelConfPath
     */
    configHome: semaclawConfigHome,

    /**
     * ${configHome}/semaclaw.db — 持久化存储（DB、router state 等）
     */
    dbPath: path.resolve(
      envOptional('DB_PATH', path.join(semaclawConfigHome, 'semaclaw.db'))
    ),
    /**
     * ${home}/agents/{folder}/ — agentDataDir
     * 存放 agent 人格文件（CLAUDE.md/soul）、memory/、.sema/sessions/
     */
    agentsDir: path.resolve(
      envOptional('AGENTS_DIR', path.join(semaclawHome, 'agents'))
    ),
    /**
     * ${home}/workspace/{folder}/ — 默认工作目录
     * 存放项目相关文档，agent 无明确项目上下文时在此工作
     */
    workspaceDir: path.resolve(
      envOptional('WORKSPACE_DIR', path.join(semaclawHome, 'workspace'))
    ),
    /**
     * ${configHome}/config.json — 全局配置
     * 用户可编辑，存放 allowedWorkDirs 等 per-agent 配置；启动时覆盖 DB 对应字段
     */
    globalConfigPath,
    /**
     * ${configHome}/dispatch-state.json — 主 Agent 任务调度状态文件
     * 存放可用 agent 列表 + 待执行/执行中/已完成的 dispatch 任务
     */
    dispatchStatePath: path.resolve(
      envOptional('SEMACLAW_DISPATCH_STATE_PATH', path.join(semaclawConfigHome, 'dispatch-state.json'))
    ),
    /**
     * ${configHome}/managed/skills — ClaWHub 安装的 skills
     * 由 `semaclaw clawhub install` 管理，对所有群组 agent 可见
     */
    managedSkillsDir: path.resolve(
      envOptional('MANAGED_SKILLS_DIR', path.join(semaclawConfigHome, 'managed', 'skills'))
    ),
    /**
     * ${home}/wiki/ — 个人知识库目录（独立 git repo）
     */
    wikiDir: path.resolve(
      envOptional('WIKI_DIR', path.join(semaclawHome, 'wiki'))
    ),
    /**
     * ${home}/virtual-agents — 虚拟 agent 人设目录
     * 存放 *.md 人设文件，PersonaRegistry 直接扫描此目录
     */
    virtualAgentsDir: path.resolve(
      envOptional('SEMACLAW_VIRTUAL_AGENTS_DIR', path.join(semaclawHome, 'virtual-agents'))
    ),
    /**
     * ${home}/workflows — 用户自定义 workflow 定义（*.md），WorkflowRegistry 扫描
     */
    workflowsDir: path.resolve(
      envOptional('SEMACLAW_WORKFLOWS_DIR', path.join(semaclawHome, 'workflows'))
    ),
    /**
     * ${configHome}/workflow-runs.json — workflow run 状态/历史
     */
    workflowStatePath: path.resolve(
      envOptional('SEMACLAW_WORKFLOW_STATE_PATH', path.join(semaclawConfigHome, 'workflow-runs.json'))
    ),
    /**
     * ${home}/workflow-runs/<runId>/ — 每次 workflow run 的共享 workspace 目录（每 run 全新，临时）
     */
    workflowRunsDir: path.resolve(
      envOptional('SEMACLAW_WORKFLOW_RUNS_DIR', path.join(semaclawHome, 'workflow-runs'))
    ),
    /**
     * ${home}/workflow-data/<name>/ — 每个 workflow 的持久目录（跨 run 保留：venv/缓存/累积输出）
     * → script step 通过 WF_WORKFLOW_DIR 访问
     */
    workflowDataDir: path.resolve(
      envOptional('SEMACLAW_WORKFLOW_DATA_DIR', path.join(semaclawHome, 'workflow-data'))
    ),
    /**
     * ${configHome}/semaclaw-model.conf — sema-core 模型配置文件路径
     * 通过 setModelConfigPathOverride 注入，使所有 CLI 子命令与 daemon 共享同一份。
     */
    modelConfPath: path.resolve(
      envOptional('SEMACLAW_MODEL_CONF_PATH', path.join(semaclawConfigHome, 'semaclaw-model.conf'))
    ),
    /**
     * <packageRoot>/skills — semaclaw 内置 bundled skills
     * 随包分发，优先级最低（用户 skills 可覆盖）。
     * 可通过 SEMACLAW_BUNDLED_SKILLS_DIR env 覆盖（开发/测试用）。
     */
    bundledSkillsDir: (() => {
      const raw = envOptional('SEMACLAW_BUNDLED_SKILLS_DIR', path.join(__dirname, '..', 'skills'))
      return raw.trim() ? path.resolve(raw) : ''
    })(),
    /**
     * 哪些路径被 env 锁定（UI 用来禁用对应输入框）。
     * 任一 env 显式设值即视为锁定，无论值是否等于默认。
     */
    envLocked: {
      home: !!process.env.SEMACLAW_HOME,
      configHome: !!process.env.SEMACLAW_CONFIG_HOME,
      agentsDir: !!process.env.AGENTS_DIR,
      workspaceDir: !!process.env.WORKSPACE_DIR,
      wikiDir: !!process.env.WIKI_DIR,
      virtualAgentsDir: !!process.env.SEMACLAW_VIRTUAL_AGENTS_DIR,
      workflowsDir: !!process.env.SEMACLAW_WORKFLOWS_DIR,
      dbPath: !!process.env.DB_PATH,
      globalConfigPath: !!process.env.SEMACLAW_CONFIG_PATH,
      dispatchStatePath: !!process.env.SEMACLAW_DISPATCH_STATE_PATH,
      managedSkillsDir: !!process.env.MANAGED_SKILLS_DIR,
      modelConfPath: !!process.env.SEMACLAW_MODEL_CONF_PATH,
    },
  },
  memory: {
    /** Embedding 提供商：none=纯FTS, openai/openrouter/ollama/local=混合搜索 */
    embeddingProvider: envOptional('SEMACLAW_EMBEDDING_PROVIDER', 'none') as 'none' | 'openai' | 'openrouter' | 'ollama' | 'local',
    openaiApiKey: envOptional('SEMACLAW_OPENAI_API_KEY', ''),
    openaiBaseUrl: envOptional('SEMACLAW_OPENAI_BASE_URL', 'https://api.openai.com/v1'),
    openaiModel: envOptional('SEMACLAW_OPENAI_MODEL', 'text-embedding-3-small'),
    openrouterApiKey: envOptional('SEMACLAW_OPENROUTER_API_KEY', ''),
    openrouterBaseUrl: envOptional('SEMACLAW_OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
    openrouterModel: envOptional('SEMACLAW_OPENROUTER_MODEL', 'openai/text-embedding-3-small'),
    ollamaBaseUrl: envOptional('SEMACLAW_OLLAMA_BASE_URL', 'http://localhost:11434'),
    ollamaModel: envOptional('SEMACLAW_OLLAMA_MODEL', 'nomic-embed-text'),
    localModelPath: envOptional('SEMACLAW_LOCAL_MODEL_PATH', ''),
    localModel: envOptional('SEMACLAW_LOCAL_MODEL', ''),
    /**
     * 向量维度。通常无需手动设置，系统按 provider 自动选择默认值：
     *   openai=1536, openrouter=1536, ollama=1536, local=384
     * 使用非默认模型时需显式设置，例如 text-embedding-3-large=3072。
     */
    embeddingDimensions: envInt('SEMACLAW_EMBEDDING_DIMENSIONS', 0),
    /** 分块大小（token 数） */
    chunkSize: envInt('SEMACLAW_CHUNK_SIZE', 400),
    /** 分块重叠（token 数） */
    chunkOverlap: envInt('SEMACLAW_CHUNK_OVERLAP', 80),
    /** pre-retrieval 最大返回条数（默认 5） */
    searchMaxResults: envInt('SEMACLAW_SEARCH_MAX_RESULTS', 5),
    /** pre-retrieval 最低分数阈值，低于此分数的结果不注入 prompt（默认 0.5） */
    searchMinScore: parseFloat(process.env.SEMACLAW_SEARCH_MIN_SCORE ?? '0.5'),
    /** 是否启用 pre-retrieval 注入（每条消息前自动搜索记忆注入 prompt） */
    preRetrieval: envOptional('SEMACLAW_PRE_RETRIEVAL', 'false') === 'true',
  },
} as const;
