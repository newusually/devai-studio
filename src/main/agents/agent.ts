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
import { ToolBox } from './tools';
import { analyzeSource, scoreReport } from '../analysis/linter';
import { getRole, pickModelForRole, AgentRole } from './roles';
import { MemoryStore } from '../memory';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

export interface AgentOptions {
  registry: ProviderRegistry;
  tools: ToolBox;
  workspace: string;
  /** 流式推送 */
  emit: (e: StreamEvent) => void;
  /** 上下文里最多带多少个诊断 */
  maxDiagnostics?: number;
  /** 记忆库（自动学习） */
  memory?: MemoryStore;
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
export const SYSTEM_PROMPT = `你是一个专业的编程助手，运行在 DevAI Studio 中。

你的能力：
1. 阅读和理解用户工作区里的代码
2. 诊断问题：语法错误、未使用的变量、缺失的导入、逻辑缺陷、设计问题
3. 提出并应用修复方案
4. 回答技术问题、解释代码、设计方案

工作方式：
- 当需要查看文件时，调用 read_file 工具
- 当需要了解目录结构时，调用 list_dir 工具
- 当需要查找代码位置时，调用 search_code 工具（参数 pattern 是正则）
- 当需要理解一段代码的问题时，调用 analyze_file 工具获取静态诊断
- 需要修改代码时，用 write_file 工具写入完整的新文件内容
- 需要执行命令验证时，用 run_command 工具（仅限白名单命令）

重要原则：
- 【证据优先】分析代码问题时，优先调用 analyze_file 或 read_file 拿到真实代码，
  不要凭空猜测代码内容。系统会提供已有的静态诊断结果，请结合它们判断。
- 【最小改动】修改代码时只改必要的部分，保持原有风格和代码组织。
- 【说明原因】每次给出修复时，用一两句话说明：错在哪、为什么这么改。
- 【中文回答】所有解释、总结、对话内容都用简体中文。
- 代码本身保持原语言该有的风格（注释语言跟随原文件）。

回答风格：直接给结论，不要用「好的，我来帮你」这类客套话。`;

export class Agent {
  constructor(private opt: AgentOptions) { }

  /** 组装系统提示（含工作区上下文与本地诊断） */
  private buildSystem(diagnostics: Diagnostic[]): string {
    let sys = SYSTEM_PROMPT;
    sys += `\n\n当前工作区：${this.opt.workspace}`;
    sys += `\n（所有工具的路径都相对于这个目录，不要用绝对路径）`;

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

    if (diagnostics.length) {
      const max = this.opt.maxDiagnostics ?? 40;
      const shown = diagnostics.slice(0, max);
      sys += `\n\n【本地静态分析已发现的 ${diagnostics.length} 个问题（按严重度排序，取前 ${shown.length} 个）】`;
      sys += `\n这些是工具扫描出来的确定性结果，请优先基于它们定位和修复：\n`;
      for (const d of shown) {
        sys += `\n- ${d.file}:${d.line}:${d.column} [${d.severity}] ${d.message}`;
        if (d.suggestion) sys += `\n  建议：${d.suggestion}`;
        if (d.snippet) sys += `\n  代码：${d.snippet}`;
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
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
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

  /** 主循环 */
  async run(
    sessionId: string,
    history: ChatMessage[],
    userText: string,
    signal: AbortSignal
  ): Promise<AgentRunResult> {
    const t0 = Date.now();
    const provider = this.opt.registry.create();
    const role = this.opt.role;
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

    /* ② 组装消息 */
    const messages: ChatMessage[] = [
      { role: 'system', content: this.buildSystem(diagnostics) },
      ...history.slice(-20),
      { role: 'user', content: userText },
    ];

    const maxRounds = 8;
    let finalContent = '';
    let lastModel = provider.model;
    let lastProvider = provider.kind;
    let patch: PatchProposal | undefined;
    const toolResults: ToolResult[] = [];

    for (let round = 0; round < maxRounds; round++) {
      if (signal.aborted) {
        return {
          content: finalContent, diagnostics,
          usage: { durationMs: Date.now() - t0, model: lastModel, provider: lastProvider },
          error: '已取消',
        };
      }

      let acc = '';
      let err: string | undefined;

      const res = await provider.chat({
        messages,
        temperature: 0.25,
        maxTokens: 4096,
        signal,
        onToken: (chunk) => {
          acc += chunk;
          this.opt.emit({ sessionId, type: 'token', text: chunk, model: lastModel, provider: lastProvider });
        },
      });

      if (res.error) {
        err = res.error;
      } else {
        lastModel = res.model;
        lastProvider = res.provider;
        finalContent = acc;
      }

      if (err) {
        this.opt.emit({ sessionId, type: 'error', error: err });
        return {
          content: finalContent, diagnostics, patch,
          usage: { durationMs: Date.now() - t0, model: lastModel, provider: lastProvider },
          error: err,
        };
      }

      /* ③ 解析工具调用 */
      const toolCall = parseToolCall(acc);
      if (!toolCall) {
        // 没有工具调用 → 结束本轮
        break;
      }

      this.opt.emit({
        sessionId, type: 'tool', toolCall,
        model: lastModel, provider: lastProvider,
      });

      const tres = await this.opt.tools.run(toolCall.name as any, toolCall.args);
      toolResults.push(tres);
      this.opt.emit({
        sessionId, type: 'tool_result', toolCall, toolResult: tres,
        model: lastModel, provider: lastProvider,
      });

      /* ④ 记录文件修改 → 生成 patch 提案 */
      if (toolCall.name === 'write_file' || toolCall.name === 'apply_patch') {
        const p = toolCall.args.path;
        const after = toolCall.args.content;
        const before = tres.data?.before ?? '';
        const change: FileChange = {
          path: p,
          type: tres.data?.created ? 'create' : 'modify',
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
      }

      /* ⑤ 把工具结果回灌给模型 */
      messages.push({ role: 'assistant', content: acc });
      messages.push({
        role: 'user',
        content: `【工具 ${toolCall.name} 执行结果】\n${tres.ok ? (tres.text || '(无输出)') : ('错误：' + (tres.error || '未知错误'))}\n\n请基于这个结果继续。`,
      });

      finalContent = acc;
    }

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
    };
  }
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
