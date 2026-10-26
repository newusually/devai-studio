/* ============================================================================
 * main/agents/agent.ts —— Agent 主循环
 * ----------------------------------------------------------------------------
 * 与 WorkBuddy / CodeBuddy 同构的思路：
 *   用户消息 → 系统提示（含工作区上下文 + 规则）→ LLM
 *     → 若返回工具调用 → 执行 → 结果回灌 → 再次调用 LLM（最多 N 轮）
 *     → 若返回文本 → 输出给用户
 *
 * 差异化设计（针对"识别我哪里写错并自动改"）：
 *   ① 每轮对话前，先对工作区最近改动的文件跑【本地静态分析】
 *      → 诊断结果作为硬证据喂给模型（不是让模型自己"眼力"找错）
 *   ② 模型可返回 patch 提案（结构化），而不是直接改文件
 *      → 用户在 UI 上看到 diff 后确认才应用（可回滚）
 *   ③ 会话内显式记录每轮用的模型 + 耗时 + 统计 → 满足"写清楚模型和分析"
 * ========================================================================== */
import { ChatMessage, Diagnostic, PatchProposal, FileChange, StreamEvent, ProviderKind, ToolResult } from '../../shared/types';
import { ProviderRegistry } from '../providers';
import { ctxForModel } from '../providers/ollama';
import { ToolBox } from './tools';
import { analyzeSource, scoreReport } from '../analysis/linter';
import { getRole, pickModelForRole, AgentRole } from './roles';
import { MemoryStore } from '../memory';
import { BuddyMemory } from '../buddy-memory';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
/* ★OpenClaw 引擎（MIT）：多轮循环 / 工具校验 / 上下文压缩 / turn 污点追踪 */
import { Agent as EngineAgent } from '../engine/agent-core/index.js';
import { createAssistantMessageEventStream } from '../engine/llm-core/index.js';

export interface AgentOptions {
  registry: ProviderRegistry;
  tools: ToolBox;
  workspace: string;
  /** 流式推送 */
  emit: (e: StreamEvent) => void;
  /** 上下文里最多带多少个诊断 */
  maxDiagnostics?: number;
  /** 是否启用深度思考（Qwen3 thinking，默认关：慢但可见推理过程） */
  thinking?: boolean;
  /** 记忆库（自动学习） */
  memory?: MemoryStore;
  /** WorkBuddy 记忆接入：读取 .workbuddy/memory/ 的经验与日志 */
  buddy?: BuddyMemory;
  /** 当前角色 */
  role?: AgentRole;
}

export interface AgentRunResult {
  content: string;
  diagnostics: Diagnostic[];
  patch?: PatchProposal;
  usage: { durationMs: number; tokens?: number; model: string; provider: ProviderKind };
  error?: string;
}

/* ---------------- 系统提示 ---------------- */
/* ★WorkBuddy「学习成果」固化基座（2026-10-26）：
   把 WorkBuddy 在真实项目里踩坑换来的通用方法论提炼成启动自带智慧，
   让 DevAI 的 AI 在任何项目一开始就具备，而不是等记忆文件注入。
   这些是跨项目普适的经验，与具体工作区的 .workbuddy/memory/ 记忆互补。 */
/* ★WorkBuddy「学习成果」固化基座（2026-10-26 二次修订）：
   原版 26 行长文注入系统提示词后，4B/9B 本地小模型会把它整段背诵出来
   替代真正的回答（复读系统提示词是小模型的经典失效模式）。
   修订：压缩成 6 行内部守则 + 显式禁止复述指令。 */
const BUDDY_WISDOM = `【内部守则（执行时遵循，严禁在回答中复述、引用或展开本守则原文）】
1. 先读真实代码/数据/日志拿到证据，再下结论，不猜。
2. 改动最小化；保持项目原有语言与风格；改完必须自己跑验证，失败就继续修。
3. 改配置/替换后必须复核生效，不匹配会静默失败。
4. 批量写先留备份；大结果用游标分页，不整读。
5. 回答直接、简短、编号化；不确定就明说缺什么。`;

/* ★操作手册（2026-10-26）：提炼自 Claude Code / OpenHands / Aider / SWE-agent /
   Open Interpreter 等顶级 Agent 的系统提示词方法论，永久内置，无需每次教学。 */
const AGENT_MANUAL = `【操作手册 —— 永久内置，照此执行】
■ 读文件/代码：read_file 读整个文件（超 2000 行自动截断）；找位置用 search_code（正则）；
  看目录用 list_dir；先读后改，禁止凭猜测改代码；大文件只读需要的部分。
■ 改代码：write_file 写完整新文件（不是片段）；写之前必须先 read_file 拿最新内容；
  最小改动=只动必须动的行；保持原缩进/引号/命名风格；改完必须 verify_project 或 run_command 验证，
  通过才算完成；汇报时说明：改了哪个文件、加/减多少行、为什么这么改。
■ 执行程序：run_command 只跑白名单命令（node/python/npm/pip/git/dir/type 等），禁止管道与元字符；
  一条命令做一件事；报错先读懂错误信息再决定下一步，禁止原样重跑同一命令。
■ 写新代码：动手前先明确"输入→处理→输出"三段；优先复用项目已有函数与工具，不自造轮子；
  命名见名知义；必须处理错误（参数校验/try-catch），不让程序带病运行；
  新文件放对目录、遵循项目现有结构；写完立即运行验证，不给用户没跑过的代码。
■ 修 bug/调试：按顺序——①读完整报错（开头+最后几行最有价值）→②read_file 定位出错代码
  →③搞清"代码意图 vs 实际行为"的差异 →④修根因而非掩盖症状，最小改动
  →⑤verify_project/run_command 复现验证。查不出原因用二分法缩小范围；
  需要运行细节就加临时日志，修完删掉临时日志再交付。
■ 分析总结：先整体后细节（先目录结构/入口文件/主流程，再抠实现）；
  分析=事实+因果（"因为X所以Y"，附文件路径与行号证据）；
  总结=结论先行+要点编号，引用关键代码行即可，不整段堆代码；结尾给下一步建议。
■ 联网查询：看网页/文档/GitHub 用 browser_open（mode=dom 拿渲染后正文；
  mode=screenshot 且给 saveAs 可截图保存到工作区）；下载文件用 fetch_url（必须给 saveAs）；
  https 超时就换 http；结果已够回答用户时立即停止查询、直接总结作答。
■ 学习记忆：用户告知的重要事实/偏好/纠错 → 调 buddy_memory_learn 存入记忆；
  接手不熟悉的任务 → 先调 buddy_memory 查已有经验，避免重复踩坑。
■ 学习方法：接手新项目先 detect_project + list_dir + 读 README/入口文件，建立全局图景再动手；
  学新技术/新库先 browser_open 查官方文档，再写最小示例跑通；
  每完成一个任务提炼一条"什么问题→怎么解决"的经验存入记忆，越用越聪明。
■ 失败处理：同一方法最多试 2 次；两次失败就换方法（换工具/换参数/换协议），
  或向用户汇报已有发现+卡点；绝不编造工具结果，绝不假装完成。`;

/* ★联网失败应对手册（2026-10-26 三次修订）：
   实测小模型在 browser_open 失败后直接输出"抱歉无法访问"然后收工结束对话
   （用户投诉："打开不了 github 就自己挂掉对话了，不处理完就走了"）。
   根治 = 手册（教它换镜像）+ few-shot 示范（4B 对模仿示范极其敏感）+ 引擎外续跑监督。 */
const FAILURE_PLAYBOOK = `【联网失败应对手册 —— 工具失败≠任务失败，禁止因此结束对话】
铁律：工具执行失败后，绝对禁止说"抱歉/我无法完成"然后停止。必须立刻换下一种方法继续，直到成功，或把"具体报错+已试方法+建议"完整汇报。
GitHub 打不开时的备选序列（按顺序换着试）：
① browser_open https://github.com/... 失败 →
② browser_open 或 fetch_url 镜像：https://gh-proxy.com/完整原地址（原地址整个拼在后面）
③ 读仓库文件用 CDN：https://cdn.jsdelivr.net/gh/用户名/仓库名@main/文件路径
④ 下载 zip 用：https://gh-proxy.com/https://codeload.github.com/用户名/仓库名/zip/refs/heads/main
⑤ 全部失败 → 汇报具体报错和已试方法，并继续做任务中不依赖该网站的部分。
其他网站：https 超时换 http；browser_open 失败换 fetch_url。
【示范 —— 工具失败后唯一正确的做法】
用户："看看 github.com/newusually 的主页"
正确动作：调 browser_open github.com/newusually → 结果"超时失败" → 不说话，立即调 browser_open https://gh-proxy.com/https://github.com/newusually → 拿到内容 → 总结回答。
禁止动作：失败后说"抱歉，我无法访问 GitHub，请您自己查看"就结束——这是逃跑，严格禁止。`;

export const SYSTEM_PROMPT = `你是一个专业的编程助手，运行在 DevAI Studio 中。

${BUDDY_WISDOM}

你的能力：
1. 阅读和理解用户工作区里的代码
2. 诊断问题：语法错误、未使用的变量、缺失的导入、逻辑缺陷、设计问题
3. 提出并应用修复方案
4. 回答技术问题、解释代码、设计方案

【工具调用格式 —— 唯一正确的调用方式，必须严格遵守】
需要用工具时，在回答里输出一个 JSON 代码块，引擎会真实执行它并把结果回传给你：
\`\`\`json
{"tool": "工具名", "args": { "参数名": "值" }}
\`\`\`
示例：
- 查看 GitHub 用户的所有仓库：{"tool": "browser_open", "args": {"url": "https://github.com/newusually?tab=repositories", "mode": "dom"}}
- 下载文件：{"tool": "fetch_url", "args": {"url": "https://example.com/file.zip", "saveAs": "file.zip"}}
- 读取文件：{"tool": "read_file", "args": {"path": "server.js"}}
- 搜索代码：{"tool": "search_code", "args": {"pattern": "函数名"}}
规则：一次只输出一个工具调用；输出后立即停止（绝不编造工具结果）；收到工具结果后继续分析或下一步。
提示：https 网站打不开（超时/拒绝）时，把 url 换成 http:// 再调一次——部分网站只开了 HTTP；若引擎提示"已自动降级 http"，直接采信结果。

工作方式：
- 当需要查看文件时，调用 read_file 工具
- 当需要了解目录结构时，调用 list_dir 工具
- 当需要查找代码位置时，调用 search_code 工具（参数 pattern 是正则）
- 当需要理解一段代码的问题时，调用 analyze_file 工具获取静态诊断
- 需要修改代码时，用 write_file 工具写入完整的新文件内容
- 需要执行命令验证时，用 run_command 工具（仅限白名单命令，禁止 shell 元字符）
- 不知道项目是什么类型、有哪些构建命令时，先调用 detect_project
- 不知道本机装了哪些运行时（Node/Python/浏览器）时，先调用 check_env
- 需要下载文件、脚本、依赖包时，用 fetch_url 下到工作区
- 需要打开网页、抓取渲染后内容、截图时，用 browser_open（无头 Edge/Chrome）
- 【自主验证】修改代码后，必须调用 verify_project 跑一遍编译/类型检查，
  看到报错就定位并继续修，直到通过或确认需要用户决策

${AGENT_MANUAL}

${FAILURE_PLAYBOOK}

【自主工作流（务必遵循）】
接到"改代码/修 bug/加功能/跑一下"类任务时，按这个循环走，不要跳步：
  1. check_env / detect_project —— 先搞清楚本机有什么、项目该怎么验证
  2. read_file / search_code —— 读真实代码，不要猜
  3. write_file —— 应用修改（最小改动）
  4. verify_project —— 自己跑一遍编译/类型检查
  5. 若失败：读报错 → 回到 3 继续修（最多几轮，别死循环）
  6. 通过后：用一两句话说明改了什么、为什么
需要装依赖时：npm install <包> 或 python -m pip install <包>（都是允许的命令）。
如果连续两轮 verify 都失败且原因相同，停止重试，把报错原文和你的判断告诉用户。

重要原则：
- 【联网铁律】需要查 GitHub/网页/文档/下载文件时，必须调用 fetch_url 或
  browser_open 工具实际执行。你完全可以联网，禁止回答"我无法查看/受权限限制"。
- 【语言铁律】严格保持工作区现有主语言。禁止把 JavaScript/TypeScript 项目改写成
  Python/Go/Rust 等，禁止修改文件扩展名，禁止删除原语言源码。
  只有当用户明确要求"用某语言重写"时才允许换语言。
- 【证据优先】分析代码问题时，优先调用 analyze_file 或 read_file 拿到真实代码，
  不要凭空猜测代码内容。系统会提供已有的静态诊断结果，请结合它们判断。
- 【最小改动】修改代码时只改必要的部分，保持原有风格和代码组织。
- 【说明原因】每次给出修复时，用一两句话说明：错在哪、为什么这么改。
- 【中文回答】所有解释、总结、对话内容都用简体中文。
- 代码本身保持原语言该有的风格（注释语言跟随原文件）。

回答风格：
- 直接给结论，不要用「好的，我来帮你」这类客套话。
- 【精炼】紧扣问题作答，说重点，控制在必要长度内；禁止重复、禁止长篇铺垫、
  禁止把简单问题展开成大段说明。需要分点时用简短列表，不要每点都展开成段落。
- 不确定或信息不足时，直接说缺什么、需要用户提供什么，不要用猜测内容填充。`;

/* ★小模型判定：1.5B/3B 级模型智力有限，长系统提示会被整段背诵（实测反复翻车），
   必须用瘦身版提示词。匹配 0.5b/1b/1.5b/2b/3b/mini 等。 */
export function isSmallModel(name?: string): boolean {
  if (!name) return false;
  return /(^|[:\-_])(0\.[5-9]b|1(\.5)?b|2b|3b)([:\-_ ]|$)|mini|instruct-small/i.test(name.toLowerCase());
}

export class Agent {
  constructor(private opt: AgentOptions) { }

  /** 组装系统提示（含工作区上下文与本地诊断） */
  private buildSystem(diagnostics: Diagnostic[], modelName?: string): string {
    /* ★2026-10-26 用户决策：取消瘦身版，所有模型（含 1.5B）一律用完整提示词+操作手册，
       用智力换稳定性。isSmallModel 保留但不再分流。 */
    void modelName;
    let sys = SYSTEM_PROMPT;
    sys += `\n\n当前工作区：${this.opt.workspace}`;
    sys += `\n（所有工具的路径都相对于这个目录，不要用绝对路径）`;

    /* ★语言锁定（硬约束）：识别工作区主语言，禁止模型擅自换语言重写。
       直接回应"我的项目全是 Node.js，会不会被乱改成 Python"这个顾虑。 */
    try {
      const d = this.opt.tools.detectProjectLanguage();
      if (d.primary) {
        sys += `\n\n【⚠️ 语言锁定 —— 最高优先级约束】\n` +
               `本工作区的主语言是 ${d.primary}（占源码文件 ${d.primaryPct}%）。\n` +
               `铁律：\n` +
               `1. 所有新增/修改的代码必须使用 ${d.primary}，禁止改用其他语言重写现有代码。\n` +
               `2. 禁止把 .js/.ts 文件改写成 .py/.go/.rs 等，禁止删除原语言文件。\n` +
               `3. 只有当用户明确说"用 X 语言重写"时，才可以换语言。\n` +
               `4. 验证命令也必须对应该语言（${d.primary} → ${d.verifyCmd}）。`;
      }
    } catch { }

    /* ★角色设定 —— 不同角色 = 不同专长 */
    const role = this.opt.role;
    if (role) {
      sys += `\n\n【当前角色：${role.name}】\n${role.prompt}`;
      sys += `\n（可用工具：${role.tools.join(', ')}）`;
    }

    /* ★自动学习：注入历史积累的项目知识 */
    if (this.opt.memory) {
      const mem = this.opt.memory.getBrief(this.opt.workspace);
      if (mem) {
        sys += `\n\n【已学习到的项目知识（自动积累，优先遵循）】\n${mem}`;
      }
    }

    /* ★WorkBuddy 记忆：读取 .workbuddy/memory/ 里的铁律/踩坑/环境事实/工作日志，
       让 AI 学会 WorkBuddy 是怎么学习、怎么思考的，并按同样的逻辑行事。 */
    if (this.opt.buddy) {
      try {
        const buddy = this.opt.buddy.read();
        if (buddy.brief) {
          sys += `\n\n${buddy.brief}`;
        }
      } catch { /* 忽略：没有记忆文件就跳过 */ }
    }

    if (diagnostics.length) {
      /* ★默认只带 12 条且**不带代码片**：诊断带 snippet 会把系统提示撑大数倍，
         CPU 推理时 prefill 要好久（表现为"一直在思考、动不了"）。 */
      const max = this.opt.maxDiagnostics ?? 12;
      const shown = diagnostics.slice(0, max);
      sys += `\n\n【本地静态分析已发现的 ${diagnostics.length} 个问题（按严重度排序，取前 ${shown.length} 个）】`;
      sys += `\n这些是工具扫描出来的确定性结果，请优先基于它们定位和修复：\n`;
      for (const d of shown) {
        sys += `\n- ${d.file}:${d.line}:${d.column} [${d.severity}] ${d.message}`;
        if (d.suggestion) sys += `\n  建议：${d.suggestion}`;
      }
      const errs = diagnostics.filter(d => d.severity === 'error').length;
      const warns = diagnostics.filter(d => d.severity === 'warning').length;
      sys += `\n\n统计：错误 ${errs} 个，警告 ${warns} 个。`;
      sys += `\n请指出其中最关键的 1-3 个问题并给出修复方案（用 write_file 应用修改）。`;
    }
    return sys;
  }

  /**
   * 扫描工作区里"最近改动的源码文件"，跑静态分析
   * 只取最近修改的 N 个文件，避免全量扫描拖慢响应
   */
  scanWorkspace(limitFiles = 12): Diagnostic[] {
    const all: Diagnostic[] = [];
    const files: Array<{ path: string; mtime: number }> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4 || files.length > 400) return;
      let entries: any[];
      try { entries = require('node:fs').readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        /* ★vendor / tmp 也要跳（2026-10-26 补）：
         *   - vendor：第三方压缩库（echarts.min.js 一个文件 1000+ 处 == 松散比较），
         *     不是用户写的代码，报出来只会淹没真问题；
         *   - tmp：本地备份/临时产物（本项目 tmp/backup_src_* 是整仓旧版快照，
         *     会把同一批警告重复报一遍）。与 ANALYZE_PROJECT 的 SKIP 集保持一致。 */
        if (e.name.startsWith('.') || e.name === 'node_modules' || e.name === 'vendor' || e.name === 'tmp') continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        const ext = extname(e.name).toLowerCase();
        if (!['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.c', '.h', '.cpp', '.java', '.rs'].includes(ext)) continue;
        try {
          const st = statSync(full);
          files.push({ path: full, mtime: st.mtimeMs });
        } catch { }
      }
    };
    walk(this.opt.workspace, 0);
    files.sort((a, b) => b.mtime - a.mtime);

    for (const f of files.slice(0, limitFiles)) {
      try {
        const content = readFileSync(f.path, 'utf8');
        const rel = relative(this.opt.workspace, f.path).replace(/\\/g, '/');
        const rep = analyzeSource(content, rel);
        all.push(...rep.diagnostics);
      } catch (e) { }
    }
    const sev = { error: 0, warning: 1, info: 2, hint: 3 };
    all.sort((a, b) => sev[a.severity] - sev[b.severity] || a.file.localeCompare(b.file) || a.line - b.line);
    return all;
  }

  /** 主循环（★已切换到 OpenClaw 引擎：agent-core 提供多轮循环、工具校验、上下文压缩） */
  async run(
    sessionId: string,
    history: ChatMessage[],
    userText: string,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const t0 = Date.now();
    const provider = this.opt.registry.create();
    const role = this.opt.role;
    /* ★立刻推状态行：本地模型 CPU 推理要几秒~几十秒，
       没有进度提示时用户看到的就是一个空白气泡（像卡死）。 */
    this.opt.emit({ sessionId, type: 'status', text: 'AI 正在生成回答…', model: provider?.model, provider: provider?.kind });
    /* ★智能回落：配置模型没装 → 自动用已装的（首次使用不报错） */
    if (provider) {
      try {
        const resolved = await this.opt.registry.resolveModel(provider.kind);
        if (resolved && resolved !== provider.model) {
          (provider as any).model = resolved;
        }
      } catch (e) { }
    }
    if (!provider) {
      return {
        content: '', diagnostics: [],
        usage: { durationMs: 0, model: '', provider: 'ollama' },
        error: '没有可用的模型来源',
      };
    }

    /* ① 本地静态分析 —— 作为硬证据 */
    let diagnostics: Diagnostic[] = [];
    try {
      diagnostics = this.scanWorkspace();
    } catch (e) { }
    if (diagnostics.length) {
      this.opt.emit({ sessionId, type: 'diagnostics', diagnostics: diagnostics.slice(0, 60) });
    }

    /* ② 引擎模型描述（★2026-10-26 重大修复：contextWindow 原来硬编码 4096，
       而系统提示词+手册已超 4K token → 引擎每轮都触发上下文压缩，
       手册和工具结果被压掉 → 表现为"不聪明、看不到失败原因"。
       现在与 provider 的 num_ctx 自适应值对齐（≤4b→8192，≥7b→4096）） */
    const engineModel = {
      id: provider.model,
      name: provider.model,
      provider: provider.kind,
      api: 'openai-completions' as const,
      baseUrl: provider.baseUrl,
      reasoning: false,
      input: ['text' as const],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: ctxForModel(provider.model),
      maxTokens: 2048,
    };
    /* 引擎错误事件需要一个完整的 AssistantMessage 外壳 */
    const errorAssistantMessage = (msg: string) => ({
      role: 'assistant' as const,
      content: [] as any[],
      api: 'openai-completions' as const,
      provider: provider.kind,
      model: provider.model,
      usage: zeroUsage(),
      stopReason: 'error' as const,
      timestamp: Date.now(),
      errorMessage: msg,
    });

    let lastModel = provider.model;
    let lastProvider = provider.kind;
    let patch: PatchProposal | undefined;
    let finalContent = '';
    let runError: string | undefined;

    /* ③ 把 provider.chat 包装成引擎的 StreamFn
     *    （引擎原生用结构化 toolCall；这里保留既有的"文本 JSON 工具调用"通道：
     *     模型先按旧格式吐 JSON → 桥接层 parseToolCall 合成结构化 toolCall → 引擎执行） */
    const streamFn = async (model: any, context: any) => {
      const stream = createAssistantMessageEventStream();
      (async () => {
        let acc = '';
        /* ★同一工具+同一参数只放行一次：小模型容易反复请求同一个工具
           （转圈烧 CPU），这里在桥接层直接拦掉。 */
        const seenCalls = new Set<string>();
        try {
          if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
          const chatMessages: ChatMessage[] = [
            { role: 'system', content: context.systemPrompt || '' },
            ...engineMessagesToChat(context.messages || []),
          ];
          const res = await provider.chat({
            messages: chatMessages,
            temperature: 0.25,
            /* ★单次生成上限 2048：本地小模型生成越久 CPU 占用越高，
             *   限长让回答更聚焦、更快出结果（对齐"CPU 99% + 回答很傻"反馈）。 */
            maxTokens: 2048,
            signal,
            thinking: this.opt.thinking === true,
            onThinking: (chunk: string) => {
              this.opt.emit({ sessionId, type: 'thinking', text: chunk, model: lastModel, provider: lastProvider });
            },
            onToken: (chunk: string) => {
              acc += chunk;
              stream.push({ type: 'text_delta', contentIndex: 0, delta: chunk });
              this.opt.emit({ sessionId, type: 'token', text: chunk, model: lastModel, provider: lastProvider });
            },
          });
          if (res.error) {
            lastModel = res.model || lastModel;
            lastProvider = res.provider || lastProvider;
            runError = res.error;
            stream.push({ type: 'error', reason: 'error', error: errorAssistantMessage(res.error) });
          } else {
            lastModel = res.model;
            lastProvider = res.provider;
            finalContent = acc;
            /* 文本 JSON 工具调用 → 结构化 toolCall（引擎执行 + schema 校验） */
            const toolCall = parseToolCall(acc);
            const content: any[] = [{ type: 'text', text: acc }];
            if (toolCall) {
              const sig = `${toolCall.name}:${JSON.stringify(toolCall.args || {})}`;
              if (seenCalls.has(sig)) {
                /* 重复调用 → 不再执行，直接结束（防转圈） */
                runError = `检测到对 ${toolCall.name} 的重复调用，已自动停止以避免空转。`;
              } else {
                seenCalls.add(sig);
                content.push({
                  type: 'toolCall',
                  id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                  name: toolCall.name,
                  arguments: toolCall.args || {},
                });
              }
            }
            stream.push({
              type: 'done',
              reason: toolCall ? 'toolUse' : 'stop',
              message: {
                role: 'assistant',
                api: 'openai-completions',
                provider: provider.kind,
                model: provider.model,
                stopReason: toolCall ? 'toolUse' : 'stop',
                timestamp: Date.now(),
                content,
                usage: zeroUsage(),
              },
            });
          }
        } catch (e: any) {
          const aborted = signal.aborted || e?.name === 'AbortError';
          runError = aborted ? '已取消' : (e?.message || String(e));
          stream.push({
            type: 'error',
            reason: aborted ? 'aborted' : 'error',
            error: errorAssistantMessage(runError || '未知错误'),
          });
        }
        stream.end();
      })();
      return stream;
    };

    /* ④ 文件修改 → patch 提案 + 改后自动复查（afterToolCall 钩子） */
    const afterToolCall = async (ctx: any) => {
      const name = ctx.toolCall?.name as string;
      if (name !== 'write_file' && name !== 'apply_patch') return undefined;
      const args = (ctx.args || {}) as { path?: string; content?: string };
      const details = (ctx.result?.details || {}) as { before?: string; created?: boolean };
      const p = args.path || '';
      const after = args.content || '';
      const before = details.before ?? '';
      const change: FileChange = {
        path: p,
        type: details.created ? 'create' : 'modify',
        before,
        after,
        diff: makeDiff(p, before, after),
        ts: Date.now(),
        applied: true,
      };
      patch = {
        id: `p${Date.now()}`,
        title: `修改 ${p}`,
        explanation: finalContent.slice(0, 800),
        changes: [change],
        risk: (before || after).length > 500 ? 'medium' : 'low',
        fromDiagnostics: diagnostics
          .filter(d => d.file === p)
          .slice(0, 10)
          .map(d => `${d.file}:${d.line}:${d.ruleId || d.message}`),
      };
      this.opt.emit({ sessionId, type: 'patch', patch });

      /* ★自主调试：改完立刻自动复查这个文件（不等模型自己想不起来） */
      let autoCheck = '';
      try {
        const chk = await this.opt.tools.run('analyze_file', { path: p });
        autoCheck = chk.ok
          ? `\n\n【改后自动复查 ${p}】\n${chk.text}`
          : `\n\n【改后自动复查失败】${chk.error || '未知错误'}`;
        this.opt.emit({
          sessionId, type: 'tool_result',
          toolCall: { name: 'analyze_file', args: { path: p } } as any,
          toolResult: chk,
          model: lastModel, provider: lastProvider,
        });
      } catch (e: any) {
        autoCheck = `\n\n【改后自动复查异常】${e?.message || e}`;
      }
      /* 把复查结果并回工具输出，让模型立刻看到 */
      const text = (ctx.result?.content || [])
        .filter((b: any) => b.type === 'text')
        .map((b: any) => b.text)
        .join('\n');
      return { content: [{ type: 'text' as const, text: text + autoCheck }] };
    };

    /* ⑤ 创建引擎 Agent 并订阅事件 → 转成 UI 事件 */
    let toolSeq = 0;
    const toolStarts = new Map<string, number>(); // callId → 开始时间
    let lastToolError = false; // ★续跑监督：本轮是否发生过工具执行失败
    const engineAgent = new EngineAgent({
      initialState: {
        systemPrompt: this.buildSystem(diagnostics, engineModel.id),
        model: engineModel,
        tools: this.opt.tools.toAgentTools(),
      },
      streamFn: streamFn as any,
      afterToolCall: afterToolCall as any,
    });

    engineAgent.subscribe((event: any) => {
      /* ★步骤计时：callId 关联 开始/结束，算出每个工具的耗时推给 UI */
      if (event.type === 'tool_execution_start') {
        const callId = `tc${++toolSeq}`;
        toolStarts.set(callId, Date.now());
        this.opt.emit({
          sessionId, type: 'tool',
          toolCall: { name: event.toolName, args: event.args, callId } as any,
          ts: Date.now(),
          model: lastModel, provider: lastProvider,
        });
      } else if (event.type === 'tool_execution_end') {
        const text = ((event.result?.content || []) as any[])
          .filter((b: any) => b.type === 'text')
          .map((b: any) => b.text)
          .join('\n');
        /* 关联最近一次同名工具的开始时间（引擎按顺序执行） */
        let callId = '';
        let durationMs = 0;
        for (const [k, v] of Array.from(toolStarts.entries()).reverse()) {
          callId = k; durationMs = Date.now() - v; toolStarts.delete(k); break;
        }
        this.opt.emit({
          sessionId, type: 'tool_result',
          toolCall: { name: event.toolName, args: event.args, callId } as any,
          toolResult: { ok: !event.isError, text, data: event.result?.details } as any,
          ts: Date.now(), durationMs,
          model: lastModel, provider: lastProvider,
        });
        if (event.isError) lastToolError = true; // ★失败记录，供续跑监督判断
      }
    });

    /* ⑥ 历史对话灌入 transcript（取最近 20 条，与旧版一致） */
    const prior: any[] = history.slice(-20).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: [{ type: 'text', text: typeof m.content === 'string' ? m.content : JSON.stringify(m.content) }],
      timestamp: Date.now(),
    }));

    /** 从引擎 transcript 取最后一条 assistant 纯文本（⑦ 汇总与续跑监督共用） */
    const lastAssistantText = (): string => {
      try {
        const msgs = (engineAgent.state.messages as any[]) || [];
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i];
          if (m.role !== 'assistant') continue;
          const t = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
          if (t.trim()) return t;
        }
      } catch { }
      return '';
    };

    try {
      if (prior.length) {
        await engineAgent.prompt(prior as any);
      }
      await engineAgent.prompt(userText);
    } catch (e: any) {
      runError = e?.message || String(e);
    }

    /* ★续跑监督（2026-10-26）：小模型工具失败后爱说"抱歉/无法"就收工结束对话
       （用户投诉："打开不了 github 就自己挂掉对话了，不处理完就走了"）。
       引擎循环外再兜一层：本轮发生过工具失败、且最终输出是"放弃型"文本时，
       强制注入继续指令再跑一轮，最多 2 次防失控。 */
    const looksSurrender = (t: string): boolean =>
      !!t && t.length < 800 &&
      /抱歉|无法|不能查看|不能访问|做不到|没有权限|受限|访问不了|打不开|请您自己|请你自行|手动查看/i.test(t);
    for (let retry = 0; retry < 2; retry++) {
      if (!lastToolError) break;
      if (!looksSurrender(lastAssistantText())) break;
      lastToolError = false; // 重置，重新观察下一轮
      this.opt.emit({
        sessionId, type: 'status',
        text: `检测到任务被中途放弃，自动换方案继续（第 ${retry + 1}/2 次）…`,
        model: lastModel, provider: lastProvider,
      });
      try {
        await engineAgent.prompt(
          '你上一步工具执行失败，但用户的任务还没完成。禁止道歉、禁止说"无法"、禁止就此结束。' +
          '按【联网失败应对手册】立刻换下一种方法（镜像 gh-proxy.com / jsdelivr / 换 http / 换 fetch_url）继续完成原始任务。' +
          '只有把备选方法全试完，才允许汇报"具体报错+已试方法+下一步建议"。'
        );
      } catch (e: any) {
        break;
      }
    }

    /* ⑦ 汇总：从 transcript 取最终文本 */
    finalContent = lastAssistantText() || finalContent;

    /* ★自动学习：把这次会话的经验沉淀下来 */
    try {
      const mem = this.opt.memory;
      if (mem) {
        mem.noteSession();
        // 记住角色/任务关键词
        if (role && role.id !== 'general') {
          mem.remember('preference', `当前偏好使用「${role.name}」角色`);
        }
        // 记住本轮发现的诊断（高频出现的问题下次优先提醒）
        for (const d of diagnostics.slice(0, 5)) {
          mem.remember('issue', d.message, d.file, d.line);
        }
        // 记住用户输入里的项目术语（中文 + 代码标识符）
        const terms = extractTerms(userText);
        for (const t of terms.slice(0, 5)) mem.remember('term', t);
      }
    } catch (e) { }

    if (runError) {
      this.opt.emit({ sessionId, type: 'error', error: runError });
    }
    this.opt.emit({
      sessionId, type: 'end',
      model: lastModel, provider: lastProvider,
      usage: { durationMs: Date.now() - t0 },
    });

    return {
      content: finalContent,
      diagnostics,
      patch,
      usage: { durationMs: Date.now() - t0, model: lastModel, provider: lastProvider },
      ...(runError ? { error: runError } : {}),
    };
  }
}

/* ---------------------------------------------------------------------------
 * 引擎消息 → dev-ai ChatMessage 转换
 * 引擎 transcript 里的 toolCall / toolResult 块转成文本 JSON 回灌给模型，
 * 与旧版"文本 JSON 工具调用"通道保持同一套格式（parseToolCall 可再解析）。
 * ------------------------------------------------------------------------- */
function engineMessagesToChat(msgs: any[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    if (m.role === 'user') {
      const text = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      if (text) out.push({ role: 'user', content: text });
    } else if (m.role === 'assistant') {
      const text = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      const calls = (m.content || []).filter((b: any) => b.type === 'toolCall');
      let c = text;
      if (calls.length) {
        const blocks = calls.map((tc: any) =>
          '```json\n' + JSON.stringify({ tool: tc.name, args: tc.arguments }) + '\n```'
        ).join('\n');
        c = c ? c + '\n' + blocks : blocks;
      }
      if (c) out.push({ role: 'assistant', content: c });
    } else if (m.role === 'toolResult') {
      const text = (m.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n');
      out.push({ role: 'user', content: `【工具 ${m.toolName || '工具'} 执行结果】\n${text}` });
    }
  }
  return out;
}

/** 引擎 usage 零值（provider 未逐 token 计数时用） */
function zeroUsage() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/* ---------------- 工具调用解析 ---------------- */
/**
 * 支持两种格式：
 *   1) JSON 块：```json\n{"tool":"read_file","args":{"path":"a.js"}}\n```
 *   2) XML 风格：<tool name="read_file">{"path":"a.js"}</tool>
 */
export function parseToolCall(text: string): { name: string; args: any } | null {
  if (!text) return null;

  // 格式 1：JSON 代码块
  const jsonBlock = text.match(/```(?:json|tool_call)?\s*\n?([\s\S]*?)```/g);
  if (jsonBlock) {
    for (const b of jsonBlock) {
      const inner = b.replace(/```(?:json|tool_call)?\s*\n?/g, '').replace(/```/g, '').trim();
      try {
        const j = JSON.parse(inner);
        const name = j.tool || j.name || j.function?.name;
        const args = j.args || j.parameters || j.function?.arguments || j.input || {};
        if (name) {
          return { name: String(name), args: typeof args === 'string' ? safeParse(args) : args };
        }
      } catch (e) { }
    }
  }

  // 格式 2：XML 风格
  const xml = text.match(/<tool\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/tool>/i);
  if (xml) {
    try {
      const args = JSON.parse(xml[2].trim());
      return { name: xml[1], args };
    } catch (e) {
      return { name: xml[1], args: {} };
    }
  }

  // 格式 3：裸 JSON（整段是 JSON）
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const j = JSON.parse(trimmed);
      const name = j.tool || j.name;
      if (name) return { name: String(name), args: j.args || j.parameters || {} };
    } catch (e) { }
  }

  return null;
}

function safeParse(s: string): any {
  try { return JSON.parse(s); } catch { return {}; }
}

/* ---------------- 简易 unified diff ---------------- */
export function makeDiff(path: string, before: string, after: string): string {
  const a = (before || '').split('\n');
  const b = (after || '').split('\n');
  const out: string[] = [`--- a/${path}`, `+++ b/${path}`];

  // 找出首个差异行
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;

  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }

  const ctxBefore = Math.max(0, start - 3);
  const hunkStart = ctxBefore + 1;
  const removed = a.slice(start, endA + 1);
  const added = b.slice(start, endB + 1);
  const context = a.slice(ctxBefore, start);

  out.push(`@@ -${hunkStart},${context.length + removed.length} +${hunkStart},${context.length + added.length} @@`);
  for (const l of context) out.push(' ' + l);
  for (const l of removed) out.push('-' + l);
  for (const l of added) out.push('+' + l);
  return out.join('\n');
}


/* ---------------- 术语抽取 ---------------- */
/** 从用户输入里抽取可能的项目术语（中文短语 / 代码标识符） */
export function extractTerms(text: string): string[] {
  const out = new Set<string>();
  // 中文连续词组（2-8 字）
  const cn = text.match(/[\u4e00-\u9fa5]{2,8}/g) || [];
  for (const w of cn) {
    if (STOP_CN.has(w)) continue;
    if (w.length >= 3) out.add(w);
  }
  // 代码标识符
  const id = text.match(/\b[A-Z][A-Za-z0-9]{2,}\b|\b[a-z]+[A-Z][A-Za-z0-9]*\b/g) || [];
  for (const w of id) {
    if (w.length >= 4) out.add(w);
  }
  return [...out];
}

const STOP_CN = new Set([
  '你好', '谢谢', '请问', '帮我', '可以', '需要', '这个', '那个', '现在', '一下',
  '怎么', '如何', '什么', '为什么', '哪里', '是否', '不能', '没有', '已经',
  '我们', '你们', '他们', '代码', '文件', '问题', '错误', '修改', '功能',
]);
