/* ============================================================================
 * main/agents/tools.ts —— Agent 可调用的工具集
 * ----------------------------------------------------------------------------
 * 工具遵循 WorkBuddy / CodeBuddy 的设计：模型输出结构化工具调用，
 * 主进程执行后把结果回传给模型，形成循环。
 *
 * 安全约束：
 *   · 所有路径都必须落在工作区内（防目录穿越）
 *   · 写文件前自动备份
 *   · run_command 只允许白名单命令（避免模型执行破坏性操作）
 * ========================================================================== */
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, copyFileSync, unlinkSync } from 'node:fs';
import type { AnalysisReport } from '../../shared/types';
import { Type } from 'typebox';
import type { AgentTool } from '../engine/agent-core/types.js';

/* ---------------------------------------------------------------------------
 * 工具目录（schema 化）—— 供 OpenClaw 引擎做原生工具调用校验/修复用。
 * 与下面 run() 的 switch 保持一一对应；新增工具时两边同步加。
 * ------------------------------------------------------------------------- */
export const TOOL_DEFS: Array<{
  name: ToolName;
  label: string;
  description: string;
  parameters: any;
}> = [
  {
    name: 'read_file', label: '读文件',
    description: '读取工作区内某个文件的完整内容',
    parameters: Type.Object({ path: Type.String({ description: '相对工作区的文件路径' }) }),
  },
  {
    name: 'write_file', label: '写文件',
    description: '把完整内容写入工作区内某个文件（自动备份原文件）',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的文件路径' }),
      content: Type.String({ description: '要写入的完整文件内容' }),
    }),
  },
  {
    name: 'list_dir', label: '列目录',
    description: '列出工作区内某个目录的内容',
    parameters: Type.Object({ path: Type.String({ description: '相对工作区的目录路径，默认 "."' }) }),
  },
  {
    name: 'search_code', label: '搜代码',
    description: '用正则搜索工作区代码内容',
    parameters: Type.Object({
      pattern: Type.String({ description: '正则表达式' }),
      glob: Type.Optional(Type.String({ description: '可选，文件过滤（如 *.ts）' })),
    }),
  },
  {
    name: 'analyze_file', label: '分析文件',
    description: '对某个源码文件跑静态分析，返回确定性诊断',
    parameters: Type.Object({ path: Type.String({ description: '相对工作区的文件路径' }) }),
  },
  {
    name: 'apply_patch', label: '应用补丁',
    description: '用完整新内容替换某个文件（语义同 write_file，用于补丁式修改）',
    parameters: Type.Object({
      path: Type.String({ description: '相对工作区的文件路径' }),
      content: Type.String({ description: '修改后的完整文件内容' }),
    }),
  },
  {
    name: 'run_command', label: '执行命令',
    description: '在工作区执行白名单命令（node/npm/git/python 等，禁 shell 元字符）',
    parameters: Type.Object({
      command: Type.String({ description: '要执行的命令' }),
      cwd: Type.Optional(Type.String({ description: '可选，执行目录' })),
    }),
  },
  {
    name: 'verify_project', label: '验证构建',
    description: '自动识别项目类型并跑对应的编译/类型检查，返回是否通过',
    parameters: Type.Object({ cwd: Type.Optional(Type.String({ description: '可选，项目目录' })) }),
  },
  {
    name: 'detect_project', label: '识别项目',
    description: '识别工作区项目类型（node/python/go 等）与可用的构建脚本',
    parameters: Type.Object({}),
  },
  {
    name: 'check_env', label: '环境探测',
    description: '探测本机运行时（Node/Python/浏览器等）版本与路径',
    parameters: Type.Object({}),
  },
  {
    name: 'fetch_url', label: '下载文件',
    description: '从 URL 下载文件并保存到工作区',
    parameters: Type.Object({
      url: Type.String({ description: '下载地址' }),
      saveAs: Type.String({ description: '保存到工作区的相对路径' }),
    }),
  },
  {
    name: 'browser_open', label: '无头浏览器',
    description: '用无头 Edge/Chrome 打开网页，抓取渲染后内容或截图',
    parameters: Type.Object({
      url: Type.String({ description: '要打开的 http/https 地址' }),
      mode: Type.Optional(Type.Union([Type.Literal('dom'), Type.Literal('screenshot')], { description: 'dom=抓正文，screenshot=截图' })),
      saveAs: Type.Optional(Type.String({ description: 'screenshot 模式下的保存路径' })),
    }),
  },
  {
    name: 'git_status', label: 'Git 状态',
    description: '查看工作区 git 状态',
    parameters: Type.Object({}),
  },
  {
    name: 'git_commit', label: 'Git 提交',
    description: '提交工作区改动',
    parameters: Type.Object({ message: Type.String({ description: '提交信息' }) }),
  },
  {
    name: 'git_diff', label: 'Git 差异',
    description: '查看工作区未提交的差异',
    parameters: Type.Object({}),
  },
  {
    name: 'buddy_memory', label: 'WorkBuddy 记忆',
    description: '读取 WorkBuddy 的 .workbuddy/memory/ 记忆（长期经验铁律/踩坑/环境事实 + 每日工作日志），让 AI 学会 WorkBuddy 如何学习与思考并按其逻辑行事。传 query 可按关键词检索',
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: '可选，检索关键词（如 "taker"、"sqlite"）' })),
    }),
  },
  {
    name: 'buddy_memory_learn', label: '沉淀学习成果',
    description: '把这次学到的经验写回项目长期记忆 .workbuddy/memory/MEMORY.md，下次自动带出。用于：踩到坑、发现关键铁律、总结可用模式',
    parameters: Type.Object({
      section: Type.String({ description: '所属小节名，如 "踩坑铁律"、"架构约定"、"部署记录"' }),
      content: Type.String({ description: '要记住的一条经验' }),
    }),
  },
];
import { join, resolve, relative, extname, dirname, basename } from 'node:path';
import { ToolName, ToolResult } from '../../shared/types';
import { BuddyMemory } from '../buddy-memory';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  '__pycache__', '.venv', 'venv', 'target', 'vendor', '.idea', '.vscode',
  'coverage', '.nyc_output', '.workbuddy', 'release',
]);

const TEXT_EXT = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml',
  '.py', '.go', '.c', '.h', '.cpp', '.hpp', '.java', '.cs', '.rs', '.php', '.rb',
  '.sh', '.bash', '.sql', '.html', '.css', '.scss', '.less', '.xml', '.toml', '.ini',
  '.env', '.gitignore', '.dockerfile', '.vue', '.svelte', '.lua', '.swift', '.kt',
]);

/** 命令白名单：只允许这些可执行文件（覆盖开发常用操作） */
const CMD_ALLOW = new Set([
  'node', 'npm', 'npx', 'yarn', 'pnpm', 'git', 'python', 'python3', 'pip',
  'tsc', 'eslint', 'jest', 'vitest', 'mocha', 'go', 'cargo', 'rustc',
  'java', 'javac', 'mvn', 'gradle', 'dotnet', 'php', 'composer', 'ruby',
  'make', 'cmake', 'echo', 'dir', 'ls', 'cat', 'type', 'pwd', 'cd',
  'curl', 'ping', 'node --version', 'npm --version',
  /* 只读诊断类（安全，提升自主排查能力） */
  'where', 'which', 'tasklist', 'netstat', 'ipconfig', 'hostname', 'nslookup',
  'grep', 'find', 'head', 'tail', 'wc', 'sort', 'uniq', 'date', 'whoami',
  'set', 'ver', 'systeminfo', 'tree', 'diff', 'cmp',
]);

/**
 * ★安全补丁（2026-10-25）：run_command 用 shell:true 执行，原先只校验第一个词，
 * 于是 `echo hi && rm -rf /`、`npm i; format c:` 这类注入能直接穿透白名单。
 * 现在显式禁止一切 shell 元字符，把命令限制成"单个可执行文件 + 普通参数"。
 */
const SHELL_META = /(&&|\|\||[;|><`$]|\$\(|\\n)/;

export class ToolBox {
  constructor(private workspace: string) { }

  /* ★WorkBuddy 记忆接入（外部注入，setWorkspace 时同步） */
  buddy: BuddyMemory | null = null;

  /* ★重复调用拦截器（2026-10-26）：同一时间窗内完全相同的调用只放行有限次数，
     超限直接拦截并回传上次结果摘要，逼模型基于已有结果回答而不是傻傻重试。 */
  private recentCalls = new Map<string, { count: number; lastMs: number; lastText: string }>();
  private static DEDUP_WINDOW_MS = 10 * 60 * 1000;
  private static DEDUP_LIMITS: Record<string, number> = {
    browser_open: 1, fetch_url: 1,            // 网络读取幂等：同 URL 一次就够（引擎壳内已带 https→http 自动降级）
    run_command: 2,
    read_file: 3, list_dir: 3, search_code: 3, analyze_file: 3,
    check_env: 2, git_status: 3, git_diff: 3, detect_project: 2, verify_project: 2,
  };

  /** 生成去重键；返回空串表示该工具不参与去重（写类/记忆类） */
  private dedupKey(name: string, args: any): string {
    try {
      const a = args || {};
      let core = '';
      switch (name) {
        case 'browser_open': core = `${String(a.url || '').replace(/\/+$/, '')}|${a.mode || 'dom'}`; break;
        case 'fetch_url': core = `${String(a.url || '').replace(/\/+$/, '')}|${a.saveAs || ''}`; break;
        case 'run_command': core = String(a.command || ''); break;
        case 'read_file': case 'analyze_file': core = String(a.path || ''); break;
        case 'list_dir': core = String(a.path || '.'); break;
        case 'search_code': core = `${a.pattern}|${a.glob || ''}`; break;
        case 'check_env': case 'git_status': case 'git_diff': case 'detect_project': case 'verify_project': core = String(a.cwd || ''); break;
        default: return '';
      }
      return `${name}::${core}`;
    } catch { return ''; }
  }

  /** 超限返回拦截结果（含上次结果摘要），未超限返回 null */
  private dedupGuard(name: string, args: any): ToolResult | null {
    const key = this.dedupKey(name, args);
    if (!key) return null;
    const now = Date.now();
    const limit = ToolBox.DEDUP_LIMITS[name] ?? 3;
    const rec = this.recentCalls.get(key);
    if (rec && now - rec.lastMs < ToolBox.DEDUP_WINDOW_MS) {
      rec.count += 1;
      if (rec.count > limit) {
        const brief = (rec.lastText || '').replace(/\s+/g, ' ').slice(0, 400);
        return {
          ok: false,
          error: `【重复调用拦截】${name} 这组参数在近几分钟内已执行过 ${rec.count - 1} 次，重试不会改变结果。上次结果摘要：${brief || '(无文本输出)'}\n\n禁止再次发起完全相同的调用。请基于上次结果直接分析并回答用户；确需新信息请换参数/换方法（https 打不开换 http、browser_open 换 fetch_url、换搜索关键词），或把已有发现汇报给用户。`,
        };
      }
    } else {
      this.recentCalls.set(key, { count: 1, lastMs: now, lastText: '' });
    }
    return null;
  }

  setWorkspace(w: string) {
    this.workspace = w;
    if (this.buddy) this.buddy.setWorkspace(w);
  }

  attachBuddy(b: BuddyMemory) { this.buddy = b; }

  /**
   * ★公开方法：识别工作区主语言 + 对应的验证命令。
   * 供 Agent 组装系统提示时做「语言锁定」硬约束用
   * （防止模型把 Node.js 项目擅自改写成 Python 等其他语言）。
   */
  detectProjectLanguage(): { primary: string; primaryPct: number; verifyCmd: string; total: number } {
    const LANG_BY_EXT: Record<string, string> = {
      '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
      '.ts': 'TypeScript', '.tsx': 'TypeScript',
      '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
      '.java': 'Java', '.cs': 'C#', '.c': 'C', '.h': 'C/C++', '.cpp': 'C++', '.hpp': 'C++',
      '.php': 'PHP', '.rb': 'Ruby',
    };
    const VERIFY_BY_LANG: Record<string, string> = {
      'JavaScript': 'node --check <文件> 或 npm test',
      'TypeScript': 'npx tsc --noEmit 或 npm run typecheck',
      'Python': 'python -m py_compile <文件>',
      'Go': 'go build ./...',
      'Rust': 'cargo check',
      'Java': 'mvn -q compile',
      'C': 'gcc -fsyntax-only <文件>',
      'C/C++': 'g++ -fsyntax-only <文件>',
      'C++': 'g++ -fsyntax-only <文件>',
      'C#': 'dotnet build',
      'PHP': 'php -l <文件>',
      'Ruby': 'ruby -c <文件>',
    };
    const langCount: Record<string, number> = {};
    let totalSrc = 0;
    const walk = (dir: string, depth: number) => {
      if (depth > 6) return;
      let entries: any[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name) || e.name === 'node_modules') continue;
          walk(join(dir, e.name), depth + 1);
        } else {
          const lang = LANG_BY_EXT[extname(e.name).toLowerCase()];
          if (lang) { langCount[lang] = (langCount[lang] || 0) + 1; totalSrc++; }
        }
      }
    };
    walk(this.workspace, 0);
    const rank = Object.entries(langCount).sort((a, b) => b[1] - a[1]);
    const primary = rank.length ? rank[0][0] : '';
    const pct = primary && totalSrc ? Math.round((rank[0][1] / totalSrc) * 100) : 0;
    return { primary, primaryPct: pct, verifyCmd: VERIFY_BY_LANG[primary] || '（自行判断）', total: totalSrc };
  }

  /** 路径安全检查：必须落在工作区内 */
  private safePath(p: string): string | null {
    if (!p) return null;
    const abs = resolve(this.workspace, p);
    const rel = relative(this.workspace, abs);
    if (rel.startsWith('..') || (rel === '' && abs !== resolve(this.workspace))) return null;
    return abs;
  }

  async run(name: ToolName, args: any): Promise<ToolResult> {
    const blocked = this.dedupGuard(name, args);
    if (blocked) return blocked;
    const res = await this.dispatch(name, args);
    const key = this.dedupKey(name, args);
    if (key) {
      const rec = this.recentCalls.get(key);
      if (rec) {
        rec.lastMs = Date.now();
        rec.lastText = res.ok ? (res.text || '') : `错误：${res.error || ''}`;
      }
    }
    return res;
  }

  private async dispatch(name: ToolName, args: any): Promise<ToolResult> {
    try {
      switch (name) {
        case 'read_file': return this.readFile(args.path);
        case 'write_file': return this.writeFile(args.path, args.content);
        case 'list_dir': return this.listDir(args.path || '.');
        case 'search_code': return this.searchCode(args.pattern, args.glob);
        case 'analyze_file': return this.analyzeFile(args.path);
        case 'apply_patch': return this.applyPatch(args.path, args.content);
        case 'run_command': return this.runCommand(args.command, args.cwd);
        case 'verify_project': return this.verifyProject(args.cwd);
        case 'detect_project': return this.detectProject();
        case 'check_env': return this.checkEnv();
        case 'fetch_url': return this.fetchUrl(args.url, args.saveAs);
        case 'browser_open': return this.browserOpen(args.url, args.mode || 'dom', args.saveAs);
        case 'git_status': return this.gitStatus();
        case 'git_commit': return this.gitCommit(args.message);
        case 'git_diff': return this.gitDiff();
        case 'buddy_memory': return this.buddyMemory(args.query);
        case 'buddy_memory_learn': return this.buddyMemoryLearn(args.section, args.content);
        default:
          return { ok: false, error: `未知工具: ${name}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /**
   * ★适配 OpenClaw 引擎：把工具目录转成引擎的 AgentTool 格式。
   * 引擎用 (toolCallId, params, signal, onUpdate) 四参签名调用，
   * 返回值要求 { content: [{type:'text',text}], details }。
   * 内部仍走原有的 run()（安全护栏/白名单/路径检查全部不变）。
   */
  toAgentTools(): AgentTool<any, any>[] {
    return TOOL_DEFS.map((def) => ({
      name: def.name,
      label: def.label,
      description: def.description,
      parameters: def.parameters,
      execute: async (
        _toolCallId: string,
        params: any,
        signal?: AbortSignal,
      ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }> => {
        const res = await this.run(def.name, params || {});
        const text = res.ok
          ? (res.text || '(工具执行成功，无文本输出)')
          : `错误：${res.error || '未知错误'}`;
        return {
          content: [{ type: 'text' as const, text }],
          details: res.data ?? { ok: res.ok },
        };
      },
    }));
  }

  /* ---------------- 读文件 ---------------- */
  private readFile(path: string): ToolResult {
    const abs = this.safePath(path);
    if (!abs) return { ok: false, error: `路径越界（必须在工作区内）: ${path}` };
    if (!existsSync(abs)) return { ok: false, error: `文件不存在: ${path}` };
    const content = readFileSync(abs, 'utf8');
    const lines = content.split('\n');
    // 大文件只返回前 2000 行，避免撑爆上下文
    const truncated = lines.length > 2000;
    const body = truncated ? lines.slice(0, 2000).join('\n') : content;
    return {
      ok: true,
      data: { path, content: body, totalLines: lines.length, truncated },
      text: `文件 ${path}（共 ${lines.length} 行${truncated ? '，已截断到前 2000 行' : ''}）：\n\`\`\`\n${body}\n\`\`\``,
    };
  }

  /* ---------------- 写文件 ---------------- */
  private writeFile(path: string, content: string): ToolResult {
    const abs = this.safePath(path);
    if (!abs) return { ok: false, error: `路径越界（必须在工作区内）: ${path}` };
    const existed = existsSync(abs);
    let before = '';
    if (existed) {
      try { before = readFileSync(abs, 'utf8'); } catch (e) { }
    }
    try {
      const dir = dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(abs, content, 'utf8');
      return {
        ok: true,
        data: { path, created: !existed, bytes: content.length, before },
        text: `${existed ? '已更新' : '已创建'} ${path}（${content.length} 字节）`,
      };
    } catch (e: any) {
      return { ok: false, error: `写入失败: ${e?.message || e}` };
    }
  }

  /* ---------------- 整文件覆盖（apply_patch 语义） ---------------- */
  private applyPatch(path: string, content: string): ToolResult {
    return this.writeFile(path, content);
  }

  /* ---------------- 列目录 ---------------- */
  listDir(path: string): ToolResult {
    const abs = this.safePath(path);
    if (!abs) return { ok: false, error: `路径越界: ${path}` };
    if (!existsSync(abs)) return { ok: false, error: `目录不存在: ${path}` };
    const st = statSync(abs);
    if (!st.isDirectory()) return { ok: false, error: `不是目录: ${path}` };
    let entries: any[] = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true }).map(e => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: e.isDirectory() ? 0 : (() => { try { return statSync(join(abs, e.name)).size; } catch { return 0; } })(),
      }));
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
    return {
      ok: true,
      data: { path, entries },
      text: entries.map(e =>
        e.type === 'dir' ? `  [DIR]  ${e.name}/` : `  [FILE] ${e.name} (${e.size}B)`
      ).join('\n') || '(空目录)',
    };
  }

  /* ---------------- 搜索代码 ---------------- */
  private searchCode(pattern: string, glob?: string): ToolResult {
    if (!pattern) return { ok: false, error: '缺少 pattern 参数' };
    let re: RegExp;
    try {
      re = new RegExp(pattern, 'gi');
    } catch (e: any) {
      return { ok: false, error: `正则表达式无效: ${e?.message || e}` };
    }
    const hits: Array<{ file: string; line: number; text: string }> = [];
    const maxHits = 200;

    const walk = (dir: string, depth: number) => {
      if (depth > 8 || hits.length >= maxHits) return;
      let entries: any[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (hits.length >= maxHits) return;
        if (e.name.startsWith('.') && e.name !== '.env') {
          if (IGNORE_DIRS.has(e.name)) continue;
        }
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name)) continue;
          walk(full, depth + 1);
        } else {
          const ext = extname(e.name).toLowerCase();
          if (!TEXT_EXT.has(ext) && !['Dockerfile', 'Makefile', '.gitignore'].includes(e.name)) continue;
          if (glob && !matchGlob(e.name, full, glob)) continue;
          let content: string;
          try { content = readFileSync(full, 'utf8'); } catch { continue; }
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            re.lastIndex = 0;
            if (re.test(lines[i])) {
              hits.push({
                file: relative(this.workspace, full).replace(/\\/g, '/'),
                line: i + 1,
                text: lines[i].trim().slice(0, 200),
              });
              if (hits.length >= maxHits) return;
            }
          }
        }
      }
    };
    walk(this.workspace, 0);

    return {
      ok: true,
      data: { pattern, count: hits.length, hits },
      text: hits.length
        ? hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n')
        : `未找到匹配 "${pattern}" 的内容`,
    };
  }

  /* ---------------- 分析文件 ---------------- */
  private analyzeFile(path: string): ToolResult {
    const abs = this.safePath(path);
    if (!abs) return { ok: false, error: `路径越界: ${path}` };
    if (!existsSync(abs)) return { ok: false, error: `文件不存在: ${path}` };
    // 延迟 require 避免循环依赖（类型用 import type，编译期擦除，无运行时环）
    const { analyzeSource, scoreReport } = require('../analysis/linter') as {
      analyzeSource(src: string, file: string): AnalysisReport;
      scoreReport(r: AnalysisReport): number;
    };
    const content = readFileSync(abs, 'utf8');
    const report: AnalysisReport = analyzeSource(content, relative(this.workspace, abs).replace(/\\/g, '/'));
    report.score = scoreReport(report);
    return {
      ok: true,
      data: report,
      text: report.diagnostics.length
        ? `发现 ${report.diagnostics.length} 个问题（评分 ${report.score}）：\n` +
        report.diagnostics.map(d =>
          `  [${d.severity}] ${d.line}:${d.column} ${d.message}${d.suggestion ? ` → ${d.suggestion}` : ''}`
        ).join('\n')
        : `未发现问题（评分 ${report.score}）`,
    };
  }

  /* ---------------- 执行命令 ---------------- */
  private async runCommand(command: string, cwd?: string): Promise<ToolResult> {
    if (!command) return { ok: false, error: '缺少 command 参数' };
    /* ★安全第一：禁止 shell 元字符（防注入穿透白名单） */
    if (SHELL_META.test(command)) {
      return {
        ok: false,
        error: '命令包含 shell 元字符（&&、;、|、>、<、`、$ 等），已拒绝执行。' +
               '请拆成单条命令，或用 verify_project 做项目级检查。',
      };
    }
    // 白名单校验：取第一个词（去掉路径和引号）
    const first = command.trim().split(/\s+/)[0].replace(/^["']|["']$/g, '');
    const base = basename(first).toLowerCase();
    const allowed = CMD_ALLOW.has(base) || CMD_ALLOW.has(first.toLowerCase());
    if (!allowed) {
      return {
        ok: false,
        error: `命令不在白名单内，已拒绝执行: ${first}\n允许的：${[...CMD_ALLOW].slice(0, 20).join(', ')} ...`,
      };
    }
    const workDir = cwd ? (this.safePath(cwd) || this.workspace) : this.workspace;
    const { spawn } = require('node:child_process');
    return new Promise<ToolResult>((resolve) => {
      const proc = spawn(command, {
        cwd: workDir,
        shell: true,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      });
      let out = '';
      let err = '';
      const cap = 20000;
      proc.stdout.on('data', (d: Buffer) => { if (out.length < cap) out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { if (err.length < cap) err += d.toString(); });
      const timer = setTimeout(() => { try { proc.kill(); } catch { } }, 120000);
      proc.on('close', (code: number | null) => {
        clearTimeout(timer);
        const ok = code === 0;
        resolve({
          ok,
          data: { code, stdout: out.slice(0, 8000), stderr: err.slice(0, 4000) },
          error: ok ? undefined : `命令退出码 ${code}`,
          text: (out || '') + (err ? `\n[stderr]\n${err}` : '') || '(无输出)',
        });
      });
      proc.on('error', (e: any) => {
        clearTimeout(timer);
        resolve({ ok: false, error: e?.message || String(e) });
      });
    });
  }

  /* ---------------- 识别项目类型 ---------------- */
  /**
   * 自动识别工作区是什么项目、该用什么命令验证。
   * 这是"自主运行调试"的基础：模型不需要猜命令，直接问工具。
   */
  private detectProject(): ToolResult {
    const ws = this.workspace;
    const found: string[] = [];
    const has = (f: string) => { try { return existsSync(join(ws, f)); } catch { return false; } };

    const kinds: Array<{ name: string; markers: string[] }> = [
      { name: 'node', markers: ['package.json'] },
      { name: 'typescript', markers: ['tsconfig.json'] },
      { name: 'go', markers: ['go.mod'] },
      { name: 'rust', markers: ['Cargo.toml'] },
      { name: 'python', markers: ['requirements.txt', 'pyproject.toml', 'setup.py'] },
      { name: 'java-maven', markers: ['pom.xml'] },
      { name: 'java-gradle', markers: ['build.gradle', 'build.gradle.kts'] },
      { name: 'dotnet', markers: ['*.csproj', '*.sln'] },
      { name: 'php', markers: ['composer.json'] },
      { name: 'ruby', markers: ['Gemfile'] },
      { name: 'make', markers: ['Makefile', 'makefile'] },
      { name: 'git', markers: ['.git'] },
    ];

    for (const k of kinds) {
      for (const m of k.markers) {
        if (m.startsWith('*')) {
          try {
            const hit = readdirSync(ws).some(e => e.toLowerCase().endsWith(m.slice(1).toLowerCase()));
            if (hit) { found.push(k.name); break; }
          } catch { }
        } else if (has(m)) { found.push(k.name); break; }
      }
    }

    /* 读取 package.json 的 scripts，让模型知道有哪些 npm 命令可用 */
    let scripts: Record<string, string> = {};
    if (has('package.json')) {
      try {
        const pkg = JSON.parse(readFileSync(join(ws, 'package.json'), 'utf8'));
        scripts = pkg.scripts || {};
      } catch { }
    }

    /* ★主语言识别：按源码文件扩展名计数，取占比最高的。
       这是"禁止把 Node 项目改成 Python"的硬约束依据。 */
    const LANG_BY_EXT: Record<string, string> = {
      '.js': 'JavaScript', '.jsx': 'JavaScript', '.mjs': 'JavaScript', '.cjs': 'JavaScript',
      '.ts': 'TypeScript', '.tsx': 'TypeScript',
      '.py': 'Python', '.go': 'Go', '.rs': 'Rust',
      '.java': 'Java', '.cs': 'C#', '.c': 'C', '.h': 'C/C++', '.cpp': 'C++', '.hpp': 'C++',
      '.php': 'PHP', '.rb': 'Ruby',
    };
    const langCount: Record<string, number> = {};
    let totalSrc = 0;
    const countLangs = (dir: string, depth: number) => {
      if (depth > 6) return;
      let entries: any[];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) {
          if (IGNORE_DIRS.has(e.name) || e.name === 'node_modules') continue;
          countLangs(join(dir, e.name), depth + 1);
        } else {
          const lang = LANG_BY_EXT[extname(e.name).toLowerCase()];
          if (lang) { langCount[lang] = (langCount[lang] || 0) + 1; totalSrc++; }
        }
      }
    };
    countLangs(ws, 0);
    const langRank = Object.entries(langCount).sort((a, b) => b[1] - a[1]);
    const primary = langRank.length ? langRank[0][0] : '';
    const primaryPct = primary && totalSrc ? Math.round((langRank[0][1] / totalSrc) * 100) : 0;

    return {
      ok: true,
      data: { types: found, scripts, languages: langRank, primary, primaryPct },
      text: `项目类型：${found.length ? found.join(', ') : '未能识别（空目录或未知类型）'}\n` +
            (primary ? `主语言：${primary}（占源码文件 ${primaryPct}%，共 ${totalSrc} 个）\n` : '') +
            (langRank.length > 1
              ? `其他语言：${langRank.slice(1).map(([l, n]) => `${l} ${n} 个`).join('，')}\n`
              : '') +
            (Object.keys(scripts).length
              ? `可用 npm 脚本：\n${Object.entries(scripts).map(([k, v]) => `  npm run ${k} → ${v}`).join('\n')}`
              : '（无 package.json 脚本）'),
    };
  }

  /* ---------------- 一键验证（自主调试的核心） ---------------- */
  /**
   * 按项目类型自动跑"编译/类型检查/测试"，把输出原样返回给模型。
   * 模型据此自己判断改对了没有、错在哪、下一步怎么改。
   */
  private async verifyProject(cwd?: string): Promise<ToolResult> {
    const d = this.detectProject();
    const types: string[] = d.data?.types || [];
    const workDir = cwd ? (this.safePath(cwd) || this.workspace) : this.workspace;
    const has = (f: string) => { try { return existsSync(join(workDir, f)); } catch { return false; } };

    /* 按优先级挑一条验证命令：先类型检查（最快定位错误），再 build，再 test */
    let cmd = '';
    let label = '';
    if (types.includes('typescript')) { cmd = 'npx tsc --noEmit'; label = 'TypeScript 类型检查'; }
    else if (types.includes('node')) {
      if (has('package.json')) {
        try {
          const pkg = JSON.parse(readFileSync(join(workDir, 'package.json'), 'utf8'));
          const s = pkg.scripts || {};
          if (s.typecheck) { cmd = 'npm run typecheck'; label = 'typecheck 脚本'; }
          else if (s.build) { cmd = 'npm run build'; label = 'build 脚本'; }
          else if (s.test) { cmd = 'npm test'; label = 'test 脚本'; }
        } catch { }
      }
      if (!cmd) { cmd = 'node --check index.js'; label = 'Node 语法检查'; }
    }
    else if (types.includes('go')) { cmd = 'go build'; label = 'Go 编译'; }
    else if (types.includes('rust')) { cmd = 'cargo check'; label = 'Cargo 检查'; }
    else if (types.includes('python')) { cmd = 'python -m compileall'; label = 'Python 编译检查'; }
    else if (types.includes('java-maven')) { cmd = 'mvn -q compile'; label = 'Maven 编译'; }
    else if (types.includes('make')) { cmd = 'make'; label = 'make 构建'; }

    if (!cmd) {
      return { ok: false, error: `未能识别可执行的验证命令（项目类型：${types.join(', ') || '未知'}）` };
    }
    if (SHELL_META.test(cmd)) {
      return { ok: false, error: `内部错误：生成的验证命令含元字符：${cmd}` };
    }

    const r = await this.runCommand(cmd, cwd);
    const passed = r.ok;
    return {
      ok: true,
      data: { label, command: cmd, passed, code: r.data?.code },
      text: `【${label}】命令：${cmd}\n结果：${passed ? '✅ 通过' : '❌ 未通过'}\n` +
            `${r.text || r.error || '(无输出)'}` +
            (passed ? '' : '\n\n请根据上面的报错定位并修复，然后用 write_file 写入修正后的文件。'),
    };
  }

  /* ---------------- 沙箱：环境探测 ---------------- */
  /**
   * 探测本机可用的运行时与无头浏览器。
   * 让模型先知道"这个机器能干什么"，再决定怎么跑代码/开浏览器。
   */
  private async checkEnv(): Promise<ToolResult> {
    const { spawn } = require('node:child_process');
    const which = (cmd: string, args: string[]): Promise<string | null> => new Promise((res) => {
      const p = spawn(cmd, args, { windowsHide: true, shell: true });
      let out = '';
      p.stdout.on('data', (d: Buffer) => out += d.toString());
      p.stderr.on('data', (d: Buffer) => out += d.toString());
      const t = setTimeout(() => { try { p.kill(); } catch { } res(null); }, 15000);
      p.on('close', (code: number | null) => { clearTimeout(t); res(code === 0 ? out.trim().split('\n')[0] : null); });
      p.on('error', () => { clearTimeout(t); res(null); });
    });

    const runtimes: Array<{ name: string; cmd: string; args: string[]; label: string }> = [
      { name: 'node', cmd: 'node', args: ['--version'], label: 'Node.js' },
      { name: 'npm', cmd: 'npm', args: ['--version'], label: 'npm' },
      { name: 'npx', cmd: 'npx', args: ['--version'], label: 'npx' },
      { name: 'python', cmd: 'python', args: ['--version'], label: 'Python' },
      { name: 'pip', cmd: 'python', args: ['-m', 'pip', '--version'], label: 'pip (python -m pip)' },
      { name: 'git', cmd: 'git', args: ['--version'], label: 'Git' },
      { name: 'go', cmd: 'go', args: ['version'], label: 'Go' },
    ];

    const lines: string[] = [];
    const avail: Record<string, boolean> = {};
    for (const r of runtimes) {
      const v = await which(r.cmd, r.args);
      avail[r.name] = !!v;
      lines.push(`${v ? '✅' : '❌'} ${r.label}${v ? ` — ${v.replace(/^[A-Za-z]+ /, '')}` : ' — 未安装'}`);
    }

    /* 无头浏览器（Edge / Chrome，用 CLI flag 驱动，无需装 puppeteer） */
    const browsers: Array<{ name: string; paths: string[] }> = [
      { name: 'Microsoft Edge', paths: ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'] },
      { name: 'Google Chrome', paths: ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'] },
    ];
    const foundBrowsers: string[] = [];
    for (const b of browsers) {
      const hit = b.paths.find(p => { try { return existsSync(p); } catch { return false; } });
      if (hit) { foundBrowsers.push(`${b.name} (${hit})`); avail[b.name] = true; }
    }
    lines.push('');
    lines.push(foundBrowsers.length
      ? `✅ 无头浏览器：${foundBrowsers.join('；')}`
      : '❌ 无头浏览器：未找到 Edge / Chrome');

    return {
      ok: true,
      data: { available: avail, browsers: foundBrowsers },
      text: `【本机沙箱环境】\n${lines.join('\n')}\n\n` +
            `可用能力：写文件 → run_command 执行 → verify_project 验证 → browser_open 开网页。\n` +
            `需要装东西时：npm install <包> 或 python -m pip install <包>。`,
    };
  }

  /* ---------------- 沙箱：下载文件 ---------------- */
  /** 把 URL 内容下载到工作区内（有大小上限，防爆盘） */
  /* ★HTTPS 失败自动降级 HTTP（与 browserOpen 同理） */
  private async fetchUrl(url: string, saveAs: string): Promise<ToolResult> {
    const r = await this.fetchUrlOnce(url, saveAs);
    if (!r.ok && /^https:\/\//i.test(url) &&
        /超时|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|fetch failed|网络/i.test(r.error || '')) {
      const fb = await this.fetchUrlOnce(url.replace(/^https:\/\//i, 'http://'), saveAs);
      if (fb.ok) return { ...fb, text: `${fb.text || ''}\n（https 失败已自动降级 http）` };
    }
    return r;
  }

  private async fetchUrlOnce(url: string, saveAs: string): Promise<ToolResult> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `仅支持 http/https URL: ${url}` };
    }
    if (!saveAs) return { ok: false, error: '缺少 saveAs 参数（工作区内的保存路径）' };
    const abs = this.safePath(saveAs);
    if (!abs) return { ok: false, error: `保存路径越界（必须在工作区内）: ${saveAs}` };

    const { createWriteStream } = require('node:fs');
    const { Readable } = require('node:stream');

    /* ★改用 Electron net.fetch（Chromium 网络栈）：
       自动继承系统代理——本机直连 GitHub 被墙，node:http 直连必失败（2026-10-26 实测根因）。 */
    try {
      const { net } = require('electron');
      const res = await net.fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 DevAI-Studio' },
        signal: AbortSignal.timeout(180000),
      });
      if (!res.ok) return { ok: false, error: `下载失败 HTTP ${res.status}` };

      const dir = dirname(abs);
      try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch { }
      const file = createWriteStream(abs);
      let size = 0;
      const CAP = 200 * 1024 * 1024; // 200MB 上限

      return await new Promise<ToolResult>((resolve) => {
        const stream = Readable.fromWeb(res.body as any);
        stream.on('data', (d: Buffer) => {
          size += d.length;
          if (size > CAP) {
            try { stream.destroy(); } catch { }
            try { file.close(); unlinkSync(abs); } catch { }
            resolve({ ok: false, error: '超过 200MB 上限，已中止' });
          }
        });
        stream.on('error', (e: any) => {
          try { file.close(); unlinkSync(abs); } catch { }
          resolve({ ok: false, error: `下载出错: ${e?.message || e}` });
        });
        stream.pipe(file);
        file.on('finish', () => file.close(() => resolve({
          ok: true,
          data: { url, saved: saveAs, bytes: size },
          text: `已下载 ${url}\n保存到 ${saveAs}（${(size / 1024).toFixed(1)} KB）`,
        })));
      });
    } catch (e: any) {
      return { ok: false, error: `下载出错: ${e?.message || e}` };
    }
  }

  /* ---------------- 沙箱：无头浏览器 ----------------
   * 实现说明：新版 Edge/Chrome 的 --headless=new 已移除 --dump-dom，
   * 所以走 CDP（Chrome DevTools Protocol）——用 Node 22 内置 WebSocket
   * 直连 DevTools，零外部依赖。
   *   mode=dom        → 抓取渲染后正文（document.body.innerText）
   *   mode=screenshot → 保存整页截图
   * ------------------------------------------------------ */
  /* ★HTTPS 失败自动降级 HTTP（2026-10-26 实测：dadi.ink 只开 80 端口，
     模型默认 https 导致 20s 超时——统一在壳层做 https→http 重试，对模型透明） */
  private async browserOpen(url: string, mode: 'dom' | 'screenshot' = 'dom', saveAs?: string): Promise<ToolResult> {
    const r = await this.browserOpenOnce(url, mode, saveAs);
    if (!r.ok && /^https:\/\//i.test(url) &&
        /超时|timeout|ETIMEDOUT|ECONNREFUSED|ECONNRESET|ERR_CONNECTION|未加载完成|导航失败/i.test(r.error || '')) {
      const fb = await this.browserOpenOnce(url.replace(/^https:\/\//i, 'http://'), mode, saveAs);
      if (fb.ok) return { ...fb, text: `${fb.text || ''}\n（注：https 连接失败，已自动降级为 http 访问）` };
    }
    return r;
  }

  private async browserOpenOnce(url: string, mode: 'dom' | 'screenshot' = 'dom', saveAs?: string): Promise<ToolResult> {
    if (!url || !/^https?:\/\//i.test(url)) {
      return { ok: false, error: `仅支持 http/https URL: ${url}` };
    }
    const candidates = [
      'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
      'C:/Program Files/Google/Chrome/Application/chrome.exe',
      'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    ];
    const exe = candidates.find(p => { try { return existsSync(p); } catch { return false; } });
    if (!exe) {
      return { ok: false, error: '未找到 Edge / Chrome，无法使用无头浏览器。可先 check_env 确认环境。' };
    }
    if (mode === 'screenshot' && !saveAs) {
      return { ok: false, error: 'screenshot 模式需要 saveAs 参数' };
    }

    const os = require('node:os');
    const { spawn } = require('node:child_process');
    const { writeFileSync, rmSync } = require('node:fs');
    const http = require('node:http');

    /* 找一个空闲调试端口 */
    const freePort = (): Promise<number> => new Promise((res) => {
      const net = require('node:net');
      const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
      s.on('error', () => res(9333));
    });

    const port = await freePort();
    const userDataDir = join(os.tmpdir(), `devai-hl-${process.pid}-${port}`);
    const proc = spawn(exe, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      '--disable-dev-shm-usage', '--hide-scrollbars', '--mute-audio',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      'about:blank',
    ], { windowsHide: true, stdio: 'ignore' });

    const cleanup = () => {
      try { proc.kill(); } catch { }
      try { rmSync(userDataDir, { recursive: true, force: true }); } catch { }
    };

    const getJson = (path: string, timeoutMs = 20000): Promise<any> => new Promise((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port, path, timeout: timeoutMs }, (res: any) => {
        let b = '';
        res.on('data', (d: Buffer) => b += d.toString());
        res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('DevTools 响应解析失败')); } });
      });
      req.on('error', (e: any) => reject(new Error(`DevTools 连接失败: ${e?.message || e}`)));
      req.on('timeout', () => { req.destroy(); reject(new Error('DevTools 连接超时')); });
    });

    const waitFor = async (fn: () => Promise<any>, tries: number, gapMs = 400): Promise<any> => {
      let lastErr: any = null;
      for (let i = 0; i < tries; i++) {
        try { return await fn(); } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, gapMs)); }
      }
      throw lastErr || new Error('等待超时');
    };

    try {
      await waitFor(() => getJson('/json/version'), 50);
      const list = await waitFor(() => getJson('/json/list'), 25);
      const page = (list || []).find((t: any) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (!page) { cleanup(); return { ok: false, error: '未找到可用的页面目标（DevTools /json/list 无 page）' }; }

      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 15000);
        ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
        ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('CDP WebSocket 连接失败')); });
      });

      let msgId = 0;
      const pending = new Map<number, (m: any) => void>();
      ws.addEventListener('message', (ev: any) => {
        try {
          const m = JSON.parse(ev.data);
          if (m.id && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); }
        } catch { }
      });
      const send = (method: string, params: any = {}): Promise<any> => new Promise((resolve, reject) => {
        const id = ++msgId;
        const t = setTimeout(() => { pending.delete(id); reject(new Error(`${method} 调用超时`)); }, 45000);
        pending.set(id, (m) => { clearTimeout(t); m.error ? reject(new Error(m.error.message || method + ' 失败')) : resolve(m.result); });
        ws.send(JSON.stringify({ id, method, params }));
      });

      await send('Page.enable');
      await send('Runtime.enable');
      const nav = await send('Page.navigate', { url });
      if (nav && nav.errorText) {
        try { ws.close(); } catch { }
        cleanup();
        return { ok: false, error: `页面导航失败: ${nav.errorText}（${url}）` };
      }

      /* 等页面加载：轮询 readyState，最多 20s */
      let ready = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 500));
        try {
          const rs = await send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
          if (rs?.result?.value === 'complete') { ready = true; break; }
        } catch { }
      }
      if (!ready) {
        try { ws.close(); } catch { }
        cleanup();
        return { ok: false, error: `页面 20s 内未加载完成（${url}），可能是网络慢或站点无响应` };
      }

      if (mode === 'screenshot') {
        const abs = this.safePath(saveAs!)!;
        const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
        try { ws.close(); } catch { }
        cleanup();
        if (!shot || !shot.data) return { ok: false, error: '截图返回为空' };
        const dir = dirname(abs);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(abs, Buffer.from(shot.data, 'base64'));
        return {
          ok: true,
          data: { mode, url, saved: saveAs, bytes: Buffer.from(shot.data, 'base64').length },
          text: `已用无头浏览器打开 ${url}\n整页截图已保存到 ${saveAs}`,
        };
      }

      const ev = await send('Runtime.evaluate', {
        expression: 'document.body ? document.body.innerText : ""',
        returnByValue: true,
      });
      try { ws.close(); } catch { }
      cleanup();
      const text: string = (ev?.result?.value || '').replace(/\n{3,}/g, '\n\n').trim();
      return {
        ok: text.length > 0,
        data: { mode, url, textLength: text.length },
        text: text
          ? `【无头浏览器打开 ${url}】渲染后正文（${text.length} 字）：\n${text.slice(0, 6000)}${text.length > 6000 ? '\n…（已截断）' : ''}`
          : `页面无可提取正文（${url}）——可能是纯 JS 渲染未完成、或页面要求交互`,
        error: text ? undefined : '未取到正文内容',
      };
    } catch (e: any) {
      cleanup();
      return { ok: false, error: `无头浏览器执行失败: ${e?.message || e}` };
    }
  }

  /* ---------------- Git ---------------- */
  private async git(args: string[]): Promise<ToolResult> {
    const workDir = this.workspace;
    const { spawn } = require('node:child_process');
    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('git', args, { cwd: workDir, shell: false, windowsHide: true });
      let out = '';
      let err = '';
      proc.stdout.on('data', (d: Buffer) => { out += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { err += d.toString(); });
      proc.on('close', (code: number | null) => {
        resolve({
          ok: code === 0,
          data: { code, stdout: out, stderr: err },
          error: code === 0 ? undefined : err.slice(0, 500),
          text: out || err || '(无输出)',
        });
      });
      proc.on('error', (e: any) => resolve({ ok: false, error: e?.message || String(e) }));
    });
  }

  private async gitStatus(): Promise<ToolResult> {
    const r = await this.git(['status', '--porcelain=v1', '-b']);
    return {
      ok: r.ok,
      data: r.data,
      error: r.error,
      text: r.text,
    };
  }

  private async gitCommit(message: string): Promise<ToolResult> {
    if (!message) return { ok: false, error: '缺少提交信息' };
    await this.git(['add', '-A']);
    const r = await this.git(['commit', '-m', message]);
    return {
      ok: r.ok,
      data: r.data,
      error: r.error,
      text: r.ok ? `提交成功：${message}\n${r.text}` : `提交失败\n${r.text}`,
    };
  }

  private async gitDiff(): Promise<ToolResult> {
    const r = await this.git(['diff', '--stat']);
    const r2 = await this.git(['diff']);
    return {
      ok: true,
      data: { stat: r.text, diff: r2.text },
      text: (r.text || '') + '\n' + (r2.text || '').slice(0, 10000),
    };
  }

  /* ---------------- WorkBuddy 记忆 ---------------- */
  /** 读取 WorkBuddy 的 .workbuddy/memory/ 记忆；query 可选做关键词过滤 */
  private buddyMemory(query?: string): ToolResult {
    if (!this.buddy) {
      return { ok: false, error: 'WorkBuddy 记忆未接入' };
    }
    try {
      const mem = this.buddy.read(true);
      if (!mem.brief && !mem.raw) {
        return { ok: true, text: '（当前工作区没有 WorkBuddy 记忆文件：未找到 .workbuddy/memory/ 目录）' };
      }
      let text = mem.brief || mem.raw;
      if (query && query.trim()) {
        const q = query.trim().toLowerCase();
        // 按行过滤：保留含关键词的行 + 所在小节标题
        const keep: string[] = [];
        let lastHead = '';
        for (const line of mem.raw.split('\n')) {
          if (/^={5,}|\[.*\]|〔.*〕|^### /.test(line)) { lastHead = line; }
          if (line.toLowerCase().includes(q)) {
            if (lastHead && !keep.includes(lastHead)) keep.push(lastHead);
            keep.push(line);
          }
        }
        text = `【WorkBuddy 记忆中与 "${query.trim()}" 相关的内容】\n` + (keep.length ? keep.join('\n') : `（未找到跟 "${query.trim()}" 相关的记忆条目，可用同事：长期经验/架构铁律/部署记录 等关键词）`);
      }
      return { ok: true, data: { files: mem.projectFiles.length + mem.userFiles.length, query }, text: text.slice(0, 12000) };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  /** 沉淀：把学习成果写回项目长期记忆 MEMORY.md */
  private buddyMemoryLearn(section?: string, content?: string): ToolResult {
    if (!this.buddy) return { ok: false, error: 'WorkBuddy 记忆未接入' };
    const r = this.buddy.learn(section || '经验积累', content || '');
    if (!r.ok) return { ok: false, error: r.error || '写入失败' };
    return { ok: true, text: r.already ? '（该经验已存在，未重复写入）' : `已把学习成果写入 ${join(this.workspace, '.workbuddy', 'memory', 'MEMORY.md')}` };
  }
}

/* 简易 glob 匹配（支持 * 和 **） */
function matchGlob(name: string, full: string, glob: string): boolean {
  const g = glob.replace(/\\/g, '/');
  const f = full.replace(/\\/g, '/');
  const re = new RegExp(
    '^' + g
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '.') + '$'
  );
  return re.test(f) || re.test(name);
}
