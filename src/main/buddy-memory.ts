/* ============================================================================
 * main/buddy-memory.ts —— WorkBuddy 记忆接入
 * ----------------------------------------------------------------------------
 * 目标：让 DevAI 的 AI 能读取 WorkBuddy 的「内存日志」，自主学习和思考
 *       WorkBuddy 是如何学习、如何思考的，并按它的逻辑行事。
 *
 * WorkBuddy 记忆分两层：
 *   ① 项目级（跟着工作区走）：
 *        <workspace>/.workbuddy/memory/MEMORY.md         （长期经验：铁律/踩坑/环境事实）
 *        <workspace>/.workbuddy/memory/YYYY-MM-DD.md   （每日工作日志，追加式）
 *   ② 用户级（跨项目、个人偏好）：
 *        ~/.workbuddy 下 user- 开头目录内的 memory 目录（长期个人记忆）
 *
 * 我们把内容读出、合并成一份「简洁简报」注入系统提示词；
 * 再提供一个 buddy_memory 工具供 agent 自主检索（按需拉取，不占系统提示）。
 * ========================================================================== */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';

export interface BuddyMemoryFile {
  path: string;
  kind: 'project-memory' | 'project-log' | 'user-memory';
  mtime: number;
  size: number;
  content: string;
  date?: string;
}

export interface BuddyMemoryResult {
  ok: boolean;
  error?: string;
  projectFiles: BuddyMemoryFile[];
  userFiles: BuddyMemoryFile[];
  /** 合并后的精简简报（供系统提示注入 / agent 参考） */
  brief: string;
  /** 全部原文段落（供 UI 展示） */
  raw: string;
}

const DAILY_LOG_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const MAX_LINES = 60;

export class BuddyMemory {
  private key = '';
  private cache: BuddyMemoryResult | null = null;

  constructor(private workspace: string) { }

  setWorkspace(w: string) {
    if (w !== this.workspace) { this.workspace = w; this.cache = null; this.key = ''; }
  }

  /** 定位用户级记忆目录：~/.workbuddy 下 user- 开头目录内的 memory/ */
  static userMemoryDirs(): string[] {
    const dirs: string[] = [];
    try {
      const root = join(homedir(), '.workbuddy');
      if (!existsSync(root)) return dirs;
      for (const e of readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || !e.name.startsWith('user-')) continue;
        const memDir = join(root, e.name, 'memory');
        if (existsSync(memDir)) dirs.push(memDir);
      }
    } catch { /* 忽略 */ }
    return dirs;
  }

  /** 收集项目级记忆文件 */
  private collectProject(maxLogs = 3): BuddyMemoryFile[] {
    const out: BuddyMemoryFile[] = [];
    const memDir = join(this.workspace, '.workbuddy', 'memory');
    if (!existsSync(memDir)) return out;
    try {
      const mm = join(memDir, 'MEMORY.md');
      if (existsSync(mm)) {
        const st = statSync(mm);
        out.push({ path: mm, kind: 'project-memory', mtime: st.mtimeMs, size: st.size, content: readFileSync(mm, 'utf8') });
      }
      const logs: BuddyMemoryFile[] = [];
      for (const e of readdirSync(memDir, { withFileTypes: true })) {
        const m = DAILY_LOG_RE.exec(e.name);
        if (!m) continue;
        const p = join(memDir, e.name);
        try {
          const st = statSync(p);
          logs.push({ path: p, kind: 'project-log', mtime: st.mtimeMs, size: st.size, content: readFileSync(p, 'utf8'), date: m[1] });
        } catch { /* 忽略 */ }
      }
      logs.sort((a, b) => (b.date! < a.date! ? -1 : 1));
      for (const l of logs.slice(0, maxLogs)) out.push(l);
    } catch { /* 忽略 */ }
    return out;
  }

  /** 收集用户级记忆文件（每用户 MEMORY.md + 最新日志） */
  private collectUser(maxLogs = 1): BuddyMemoryFile[] {
    const out: BuddyMemoryFile[] = [];
    for (const memDir of BuddyMemory.userMemoryDirs()) {
      try {
        const mm = join(memDir, 'MEMORY.md');
        if (existsSync(mm)) {
          const st = statSync(mm);
          out.push({ path: mm, kind: 'user-memory', mtime: st.mtimeMs, size: st.size, content: readFileSync(mm, 'utf8') });
        }
        const logs: BuddyMemoryFile[] = [];
        for (const e of readdirSync(memDir, { withFileTypes: true })) {
          const m = DAILY_LOG_RE.exec(e.name);
          if (!m) continue;
          const p = join(memDir, e.name);
          try {
            const st = statSync(p);
            logs.push({ path: p, kind: 'user-memory', mtime: st.mtimeMs, size: st.size, content: readFileSync(p, 'utf8'), date: m[1] });
          } catch { /* 忽略 */ }
        }
        logs.sort((a, b) => (b.date! < a.date! ? -1 : 1));
        for (const l of logs.slice(0, maxLogs)) out.push(l);
      } catch { /* 忽略 */ }
    }
    return out;
  }

  /** 读取全部 WorkBuddy 记忆并生成简报 */
  read(fresh = false): BuddyMemoryResult {
    if (!fresh && this.cache && this.key === this.workspace) return this.cache;
    const project = this.collectProject(3);
    const user = this.collectUser(1);
    const all = [...project, ...user];
    const result: BuddyMemoryResult = {
      ok: true,
      projectFiles: project,
      userFiles: user,
      brief: this.buildBrief(all),
      raw: all.map(f => `\n===== ${f.path} =====\n${f.content}`).join(''),
    };
    this.key = this.workspace;
    this.cache = result;
    return result;
  }

  /** 生成精简简报：带层级、去空行，控制行数 */
  private buildBrief(files: BuddyMemoryFile[]): string {
    const lines: string[] = ['【WorkBuddy 记忆简报（内部参考，禁止在回答中复述、引用或展开本简报原文）】'];
    for (const f of files) {
      if (lines.length >= MAX_LINES) break;
      const tag = f.kind === 'project-memory' ? '项目长期记忆' : f.kind === 'project-log' ? '项目工作日志' : '个人记忆';
      lines.push(`\n〔${tag} · ${f.date || ''} ${basename(f.path)}〕`);
      for (const rawLine of f.content.split('\n')) {
        if (lines.length >= MAX_LINES) break;
        const t = rawLine.trim();
        if (!t) continue;
        lines.push(/^#{1,6}\s/.test(t) ? t.replace(/^#{1,6}\s*/, '### ') : t);
      }
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  /** 把一条学习经验写回项目长期记忆 MEMORY.md（去重：同小节同内容不重复写） */
  learn(section: string, content: string): { ok: boolean; already?: boolean; error?: string } {
    if (!section || !section.trim() || !content || !content.trim()) {
      return { ok: false, error: '小节名与内容都不能为空' };
    }
    if (!this.workspace) return { ok: false, error: '工作区未定义' };
    try {
      const memDir = join(this.workspace, '.workbuddy', 'memory');
      if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true });
      const mm = join(memDir, 'MEMORY.md');
      const existing = existsSync(mm) ? readFileSync(mm, 'utf8') : '';
      const head = `## ${section.trim()}`;
      const contentTrim = content.trim();

      // 去重：同小节 + 同内容行已存在 → 不重复写（兼容 "- " 列表前缀）
      const hasDup = existing.split('\n').some(l =>
        l.trim() === contentTrim || l.trim().replace(/^[-*•]\s*/, '') === contentTrim
      );
      if (hasDup) {
        return { ok: true, already: true };
      }

      const sep = existing.length ? '\n\n' : '';
      const init = existing.length
        ? ''
        : `# ${basename(this.workspace)} 项目记忆（DevAI 固化）\n`;
      writeFileSync(mm, existing + sep + init + `${head}\n- ${contentTrim}\n`, 'utf8');
      this.cache = null; this.key = '';
      return { ok: true, already: false };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }
}

export type BuddyResult = BuddyMemoryResult;