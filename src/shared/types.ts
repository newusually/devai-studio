/* ============================================================================
 * shared/types.ts —— 主进程 / 渲染进程 / Agent 共享的类型契约
 * ========================================================================== */

/* ---------------- Provider（模型来源） ---------------- */
export type ProviderKind = 'ollama' | 'openrouter' | 'gemini' | 'groq' | 'custom';

export interface ProviderConfig {
  kind: ProviderKind;
  name: string;
  /** API 根地址，如 http://127.0.0.1:11434 */
  baseUrl?: string;
  /** 模型 id */
  model: string;
  /** 密钥（主进程持有，渲染进程永远拿不到明文） */
  apiKey?: string;
  /** 是否已配置好可用 */
  available?: boolean;
  /** 本地模型（离线可用） */
  local?: boolean;
  /** 免费额度说明，用于 UI 展示 */
  freeQuota?: string;
}

export interface ModelInfo {
  id: string;
  provider: ProviderKind;
  name: string;
  /** 模型大小描述，如 5.2GB */
  size?: string;
  /** 量化等级 */
  quantization?: string;
  contextLength?: number;
  local: boolean;
  free: boolean;
  /** 是否已下载到本地 */
  downloaded?: boolean;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  /** 工具调用的结构化载荷 */
  toolCall?: ToolCall;
  /** assistant 消息里引用的文件 */
  attachments?: FileRef[];
  /** 时间戳 */
  ts?: number;
  /** 模型标识，用于会话内显示"这次是哪个模型答的" */
  model?: string;
  provider?: ProviderKind;
  /** 统计 */
  usage?: { promptTokens?: number; completionTokens?: number; durationMs?: number };
}

export interface FileRef {
  path: string;
  /** 引用该文件时的作用说明 */
  note?: string;
}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  id?: string;
}

/* ---------------- 工具（Agent 可调用） ---------------- */
export type ToolName =
  | 'read_file'
  | 'write_file'
  | 'list_dir'
  | 'search_code'
  | 'analyze_file'
  | 'apply_patch'
  | 'run_command'
  | 'git_status'
  | 'git_commit'
  | 'git_diff';

export interface ToolResult {
  ok: boolean;
  data?: any;
  error?: string;
  /** 供 LLM 阅读的文本摘要 */
  text?: string;
}

/* ---------------- 代码分析 ---------------- */
export type DiagnosticSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface Diagnostic {
  file: string;
  line: number;
  column: number;
  endLine?: number;
  endColumn?: number;
  severity: DiagnosticSeverity;
  /** 规则来源：eslint / builtin / llm */
  source: string;
  ruleId?: string;
  message: string;
  /** 修复建议 */
  suggestion?: string;
  /** 原始代码片段 */
  snippet?: string;
}

export interface AnalysisReport {
  file: string;
  diagnostics: Diagnostic[];
  /** 统计 */
  stats: {
    lines: number;
    codeLines: number;
    commentLines: number;
    functions: number;
    classes: number;
    imports: number;
    complexity?: number;
  };
  /** LLM 深度分析（可为空） */
  llmSummary?: string;
  /** 整体评分 0-100 */
  score?: number;
  analyzedAt: number;
}

/* ---------------- 文件修改 ---------------- */
export interface FileChange {
  path: string;
  type: 'create' | 'modify' | 'delete';
  before?: string;
  after?: string;
  /** unified diff */
  diff?: string;
  /** 应用时间 */
  ts: number;
  /** 是否已应用 */
  applied: boolean;
}

export interface PatchProposal {
  id: string;
  title: string;
  explanation: string;
  changes: FileChange[];
  /** 风险等级 */
  risk: 'low' | 'medium' | 'high';
  /** 应用的诊断 id */
  fromDiagnostics?: string[];
}

/* ---------------- 会话 ---------------- */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 工作区路径 */
  workspace?: string;
  messageCount: number;
  /** 摘要预览 */
  preview?: string;
  /** 用过的模型 */
  models?: string[];
}

export interface SessionDetail extends Session {
  messages: ChatMessage[];
  diagnostics?: Diagnostic[];
  changes?: FileChange[];
}

/* ---------------- IPC 通道 ---------------- */
export const IPC = {
  // 会话
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_GET: 'session:get',
  SESSION_DELETE: 'session:delete',
  SESSION_RENAME: 'session:rename',
  SESSION_EXPORT: 'session:export',

  // 对话
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_STREAM: 'chat:stream',

  // 模型
  MODEL_LIST: 'model:list',
  MODEL_SET: 'model:set',
  MODEL_PROBE: 'model:probe',
  PROVIDER_SET_KEY: 'provider:setKey',
  PROVIDER_LIST: 'provider:list',

  // 文件
  FILE_OPEN: 'file:open',
  FILE_READ: 'file:read',
  FILE_WRITE: 'file:write',
  FILE_TREE: 'file:tree',
  FILE_SEARCH: 'file:search',

  // 分析
  ANALYZE_FILE: 'analyze:file',
  ANALYZE_WORKSPACE: 'analyze:workspace',

  // 修复
  PATCH_PROPOSE: 'patch:propose',
  PATCH_APPLY: 'patch:apply',
  PATCH_REJECT: 'patch:reject',

  // Git
  GIT_STATUS: 'git:status',
  GIT_INIT: 'git:init',
  GIT_COMMIT: 'git:commit',
  GIT_DIFF: 'git:diff',
  GIT_PUSH: 'git:push',

  // 角色 / Agent
  ROLE_LIST: 'role:list',
  ROLE_SET: 'role:set',

  // 自动学习
  MEMORY_GET: 'memory:get',
  MEMORY_CLEAR: 'memory:clear',
  MEMORY_LEARN_FILE: 'memory:learnFile',

  // 模型管理
  MODEL_PULL: 'model:pull',
  MODEL_RECOMMEND: 'model:recommend',

  // 短视频
  VIDEO_SCRIPT: 'video:script',
  VIDEO_GENERATE: 'video:generate',

  // 系统
  APP_INFO: 'app:info',
  DIALOG_OPEN_DIR: 'dialog:openDir',
  DIALOG_SAVE_FILE: 'dialog:saveFile',
} as const;

/* ---------------- 主进程 → 渲染进程 推送 ---------------- */
export interface StreamEvent {
  sessionId: string;
  type: 'start' | 'token' | 'tool' | 'tool_result' | 'diagnostics' | 'patch' | 'end' | 'error' | 'aborted';
  /** 文本增量 */
  text?: string;
  /** 工具调用 */
  toolCall?: ToolCall;
  toolResult?: ToolResult;
  /** 诊断结果 */
  diagnostics?: Diagnostic[];
  /** 修复提案 */
  patch?: PatchProposal;
  /** 错误 */
  error?: string;
  /** 本轮使用的模型 */
  model?: string;
  provider?: ProviderKind;
  /** 统计 */
  usage?: { durationMs?: number; tokens?: number };
}
