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
import { join, resolve, relative, extname, dirname, basename } from 'node:path';
import { ToolName, ToolResult } from '../../shared/types';

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
]);

export class ToolBox {
  constructor(private workspace: string) { }

  setWorkspace(w: string) { this.workspace = w; }

  /** 路径安全检查：必须落在工作区内 */
  private safePath(p: string): string | null {
    if (!p) return null;
    const abs = resolve(this.workspace, p);
    const rel = relative(this.workspace, abs);
    if (rel.startsWith('..') || (rel === '' && abs !== resolve(this.workspace))) return null;
    return abs;
  }

  async run(name: ToolName, args: any): Promise<ToolResult> {
    try {
      switch (name) {
        case 'read_file': return this.readFile(args.path);
        case 'write_file': return this.writeFile(args.path, args.content);
        case 'list_dir': return this.listDir(args.path || '.');
        case 'search_code': return this.searchCode(args.pattern, args.glob);
        case 'analyze_file': return this.analyzeFile(args.path);
        case 'apply_patch': return this.applyPatch(args.path, args.content);
        case 'run_command': return this.runCommand(args.command, args.cwd);
        case 'git_status': return this.gitStatus();
        case 'git_commit': return this.gitCommit(args.message);
        case 'git_diff': return this.gitDiff();
        default:
          return { ok: false, error: `未知工具: ${name}` };
      }
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
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
    // 延迟 require 避免循环依赖
    const { analyzeSource, scoreReport } = require('../analysis/linter');
    const content = readFileSync(abs, 'utf8');
    const report = analyzeSource(content, relative(this.workspace, abs).replace(/\\/g, '/'));
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
      proc.stdout.on('data', d => { if (out.length < cap) out += d.toString(); });
      proc.stderr.on('data', d => { if (err.length < cap) err += d.toString(); });
      const timer = setTimeout(() => { try { proc.kill(); } catch { } }, 120000);
      proc.on('close', (code) => {
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

  /* ---------------- Git ---------------- */
  private async git(args: string[]): Promise<ToolResult> {
    const workDir = this.workspace;
    const { spawn } = require('node:child_process');
    return new Promise<ToolResult>((resolve) => {
      const proc = spawn('git', args, { cwd: workDir, shell: false, windowsHide: true });
      let out = '';
      let err = '';
      proc.stdout.on('data', d => { out += d.toString(); });
      proc.stderr.on('data', d => { err += d.toString(); });
      proc.on('close', (code) => {
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
      text: r.text + '\n' + r2.text.slice(0, 10000),
    };
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
