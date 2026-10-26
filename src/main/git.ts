/* ============================================================================
 * main/git.ts —— Git 服务（供对话界面与"上传到 GitHub"功能使用）
 * ----------------------------------------------------------------------------
 * 全部走 git 命令行（不依赖 isomorphic-git），Windows 自带 Git 即可。
 * 若系统无 Git，会给出明确提示而不是静默失败。
 * ========================================================================== */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface GitResult {
  ok: boolean;
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export class GitService {
  constructor(private workspace: string) { }

  setWorkspace(w: string) { this.workspace = w; }

  private run(args: string[], input?: string): Promise<GitResult> {
    return new Promise((resolve) => {
      const p = spawn('git', args, {
        cwd: this.workspace,
        shell: false,
        windowsHide: true,
      });
      let out = '';
      let err = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { err += d.toString(); });
      p.on('error', (e: any) => {
        resolve({
          ok: false,
          error: e?.code === 'ENOENT'
            ? '未找到 git 命令。请安装 Git for Windows 并确保在 PATH 中：https://git-scm.com/download/win'
            : e?.message || String(e),
        });
      });
      p.on('close', (code) => {
        resolve({ ok: code === 0, code: code ?? undefined, stdout: out, stderr: err });
      });
    });
  }

  async isRepo(): Promise<boolean> {
    const r = await this.run(['rev-parse', '--is-inside-work-tree']);
    return r.ok && r.stdout?.trim() === 'true';
  }

  async status(): Promise<GitResult & { branch?: string; files?: Array<{ path: string; status: string }> }> {
    if (!(await this.isRepo())) {
      return { ok: false, error: '当前目录不是 Git 仓库', branch: '', files: [] };
    }
    const br = await this.run(['rev-parse', '--abbrev-ref', 'HEAD']);
    const st = await this.run(['status', '--porcelain=v1']);
    const files = (st.stdout || '')
      .split('\n')
      .filter(Boolean)
      .map(l => ({
        path: l.slice(3).trim(),
        status: l.slice(0, 2).trim(),
      }));
    return {
      ok: true,
      branch: br.stdout?.trim() || '',
      files,
      stdout: st.stdout,
    };
  }

  async init(): Promise<GitResult> {
    if (await this.isRepo()) return { ok: true, stdout: '已经是 Git 仓库' };
    const r = await this.run(['init']);
    if (r.ok) {
      // 初始提交前先设置一个仓库级身份（避免因缺 user.name 报错）
      await this.run(['config', 'user.name', 'DevAI Studio']);
      await this.run(['config', 'user.email', 'devai@localhost']);
      await this.run(['config', 'core.autocrlf', 'false']);
    }
    return r;
  }

  async commit(message: string): Promise<GitResult> {
    if (!message.trim()) return { ok: false, error: '提交信息不能为空' };
    if (!(await this.isRepo())) {
      const init = await this.init();
      if (!init.ok) return init;
    }
    await this.run(['add', '-A']);
    const st = await this.run(['status', '--porcelain']);
    if (!st.stdout?.trim()) return { ok: false, error: '没有待提交的更改' };
    return this.run(['commit', '-m', message]);
  }

  async diff(): Promise<GitResult> {
    if (!(await this.isRepo())) return { ok: false, error: '不是 Git 仓库' };
    const stat = await this.run(['diff', '--stat']);
    const full = await this.run(['diff']);
    const untracked = await this.run(['ls-files', '--others', '--exclude-standard']);
    return {
      ok: true,
      stdout: (stat.stdout || '') + (full.stdout || '') +
        (untracked.stdout ? `\n[未跟踪文件]\n${untracked.stdout}` : ''),
    };
  }

  async addRemote(url: string): Promise<GitResult> {
    if (!url) return { ok: false, error: '远程地址不能为空' };
    const existing = await this.run(['remote']);
    if (existing.stdout?.includes('origin')) {
      return this.run(['remote', 'set-url', 'origin', url]);
    }
    return this.run(['remote', 'add', 'origin', url]);
  }

  async push(remote?: string, branch?: string): Promise<GitResult> {
    if (!(await this.isRepo())) return { ok: false, error: '不是 Git 仓库' };
    const br = branch || (await this.run(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout?.trim() || 'main';
    const rem = remote || 'origin';
    const remotes = await this.run(['remote']);
    if (!remotes.stdout?.includes(rem)) {
      return { ok: false, error: `没有配置远程仓库 ${rem}。请先在设置里填写 GitHub 仓库地址。` };
    }
    const r = await this.run(['push', '-u', rem, br]);
    if (!r.ok && /could not find remote|not found/i.test(r.stderr || '')) {
      return { ok: false, error: '远程仓库不存在或无访问权限。请确认 GitHub 仓库地址与权限。', stderr: r.stderr };
    }
    return r;
  }

  async getConfig(key: string): Promise<string> {
    const r = await this.run(['config', '--get', key]);
    return r.stdout?.trim() || '';
  }

  async setConfig(key: string, value: string): Promise<GitResult> {
    return this.run(['config', key, value]);
  }
}
