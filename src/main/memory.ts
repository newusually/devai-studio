/* ============================================================================
 * main/memory.ts —— 自动学习记忆库
 * ----------------------------------------------------------------------------
 * 目的：让软件"越用越懂你的项目"，且完全本地、零成本、零隐私外泄。
 *
 * 学习什么（全部自动，无需用户手动维护）：
 *   1. 项目画像：用了什么框架、语言、构建工具、目录结构约定
 *   2. 编码偏好：命名风格、缩进、引号偏好、是否用分号、注释语言
 *   3. 高频问题：哪些文件的哪些行反复出错 → 下次直接提醒
 *   4. 术语表：用户反复提到的项目专有名词 → 中英对照
 *   5. 修复模式：成功应用过的修复类型 → 下次优先推荐
 *
 * 存储：workspace/.devai/memory.json（跟着项目走，可提交到 Git，团队共享）
 * ========================================================================== */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ProjectProfile {
  /** 语言分布 */
  languages: Record<string, number>;
  /** 框架/库关键词 */
  frameworks: string[];
  /** 构建/测试工具 */
  tooling: string[];
  /** 目录结构约定 */
  conventions: string[];
  /** 命名风格 */
  namingStyle?: 'camelCase' | 'snake_case' | 'PascalCase' | 'kebab-case' | 'mixed';
  /** 缩进 */
  indent?: '2 spaces' | '4 spaces' | 'tab';
  /** 引号偏好 */
  quotes?: 'single' | 'double' | 'mixed';
  /** 分号偏好 */
  semicolons?: boolean;
  /** 注释语言 */
  commentLang?: '中文' | 'English' | 'mixed';
}

export interface MemoryEntry {
  id: string;
  kind: 'issue' | 'fix' | 'term' | 'note' | 'preference';
  /** 关联文件 */
  file?: string;
  /** 关联行 */
  line?: number;
  /** 内容 */
  content: string;
  /** 命中次数 */
  hits: number;
  createdAt: number;
  updatedAt: number;
}

export interface MemoryData {
  version: number;
  profile: ProjectProfile;
  entries: MemoryEntry[];
  /** 统计 */
  stats: { sessions: number; fixes: number; issuesFound: number };
}

const EMPTY: MemoryData = {
  version: 1,
  profile: { languages: {}, frameworks: [], tooling: [], conventions: [] },
  entries: [],
  stats: { sessions: 0, fixes: 0, issuesFound: 0 },
};

/* 框架识别特征 */
const FRAMEWORK_SIGNS: Record<string, string[]> = {
  'React': ['react', 'useState', 'useEffect'],
  'Vue': ['vue', 'ref(', 'reactive('],
  'Electron': ['electron', 'BrowserWindow', 'ipcMain'],
  'Express': ['express', 'app.get(', 'app.post('],
  'NestJS': ['@nestjs/', 'NestFactory'],
  'Fastify': ['fastify', 'fastify.'],
  'Koa': ['koa', 'koa-router'],
  'Next.js': ['next', 'getServerSideProps'],
  'Vite': ['vite', 'defineConfig'],
  'Webpack': ['webpack', 'module.exports'],
  'TypeScript': ['typescript', 'interface ', ': string'],
  'Tailwind': ['tailwind', 'className="'],
  'SQLite': ['node:sqlite', 'better-sqlite3', 'sqlite3'],
  'Prisma': ['prisma', '@prisma/'],
  'Sequelize': ['sequelize', '@sequelize/'],
  'TypeORM': ['typeorm', '@Entity'],
  'MongoDB': ['mongoose', 'mongodb://'],
  'Redis': ['ioredis', 'createClient'],
  'WebSocket': ['WebSocket', 'ws://', 'socket.io'],
  'Playwright/Puppeteer': ['puppeteer', 'playwright'],
  'Electron-builder': ['electron-builder'],
  'Jest/Vitest': ['jest', 'vitest', 'describe('],
};

/* 工具识别特征 */
const TOOL_SIGNS: Record<string, string[]> = {
  'npm': ['"scripts"'], 'pnpm': ['pnpm-lock'], 'yarn': ['yarn.lock'],
  'Docker': ['Dockerfile', 'docker-compose'], 'GitHub Actions': ['.github/workflows'],
  'ESLint': ['.eslintrc', 'eslint.config'], 'Prettier': ['.prettierrc', 'prettier'],
  'Webpack': ['webpack.config'], 'Vite': ['vite.config'],
};

export class MemoryStore {
  private data: MemoryData = { ...EMPTY };
  private file: string;
  private dirty = false;
  private saveTimer: any = null;

  constructor(private workspace: string) {
    this.file = join(workspace, '.devai', 'memory.json');
    this.load();
  }

  private load() {
    try {
      if (existsSync(this.file)) {
        const j = JSON.parse(readFileSync(this.file, 'utf8'));
        this.data = {
          version: j.version || 1,
          profile: { ...EMPTY.profile, ...(j.profile || {}) },
          entries: Array.isArray(j.entries) ? j.entries : [],
          stats: { ...EMPTY.stats, ...(j.stats || {}) },
        };
      }
    } catch (e) {
      this.data = { ...EMPTY, entries: [], stats: { ...EMPTY.stats } };
    }
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      if (this.dirty) this.save();
    }, 3000);
    if (this.saveTimer.unref) this.saveTimer.unref();
  }

  save() {
    try {
      const dir = join(this.workspace, '.devai');
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.data, null, 2), 'utf8');
      this.dirty = false;
    } catch (e) { }
  }

  /* ---------------- 学习：扫描项目 ---------------- */
  /** 扫描一个文件，更新项目画像 */
  learnFromFile(file: string, content: string) {
    const p = this.data.profile;

    // 语言统计
    const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
    const langMap: Record<string, string> = {
      ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
      mjs: 'JavaScript', cjs: 'JavaScript', py: 'Python', go: 'Go', rs: 'Rust',
      java: 'Java', cs: 'C#', cpp: 'C++', c: 'C', h: 'C', php: 'PHP', rb: 'Ruby',
      vue: 'Vue', svelte: 'Svelte', html: 'HTML', css: 'CSS', scss: 'SCSS',
      md: 'Markdown', json: 'JSON', yml: 'YAML', yaml: 'YAML', sql: 'SQL',
      sh: 'Shell', bat: 'Batch', cmd: 'Batch',
    };
    const lang = langMap[ext];
    if (lang) p.languages[lang] = (p.languages[lang] || 0) + 1;

    // 框架识别
    const head = content.slice(0, 4000);
    for (const [fw, signs] of Object.entries(FRAMEWORK_SIGNS)) {
      if (p.frameworks.includes(fw)) continue;
      if (signs.some(s => head.includes(s))) p.frameworks.push(fw);
    }
    for (const [tool, signs] of Object.entries(TOOL_SIGNS)) {
      if (p.tooling.includes(tool)) continue;
      if (signs.some(s => content.includes(s))) p.tooling.push(tool);
    }

    // 代码风格统计
    const lines = content.split('\n');
    if (lines.length > 5) {
      const indent2 = lines.filter(l => /^\t/.test(l)).length;
      const indent4 = lines.filter(l => /^ {4}\S/.test(l)).length;
      const indent2s = lines.filter(l => /^ {2}\S/.test(l)).length;
      if (indent2 > indent4 && indent2 > indent2s) p.indent = '2 spaces';
      else if (indent4 > 0) p.indent = '4 spaces';
      else if (indent2 > 0) p.indent = '2 spaces';
      else if (indent2s === 0 && indent4 === 0) { /* 无缩进样本 */ }

      const dq = (content.match(/"/g) || []).length;
      const sq = (content.match(/'/g) || []).length;
      if (dq > sq * 2) p.quotes = 'double';
      else if (sq > dq * 2) p.quotes = 'single';

      const semi = (content.match(/;/g) || []).length;
      const noSemi = lines.filter(l => /^\s*(const|let|var|return|if)\b.*[^;{}]$/.test(l)).length;
      if (semi > 0 && noSemi > semi) p.semicolons = false;
      else if (semi > 0) p.semicolons = true;

      // 注释语言
      const cnComments = (content.match(/[一-龥]/g) || []).length;
      const enComments = (content.match(/\/\/[ ]*[A-Za-z]{4,}/g) || []).length;
      if (cnComments > enComments * 2) p.commentLang = '中文';
      else if (enComments > cnComments * 2) p.commentLang = 'English';
      else if (cnComments > 0) p.commentLang = 'mixed';
    }

    this.scheduleSave();
  }

  /** 记住一条经验 */
  remember(kind: MemoryEntry['kind'], content: string, file?: string, line?: number) {
    if (!content || !content.trim()) return;
    // 去重：同类同内容只累加 hits
    const exist = this.data.entries.find(e =>
      e.kind === kind && e.content === content && e.file === file
    );
    if (exist) {
      exist.hits++;
      exist.updatedAt = Date.now();
    } else {
      this.data.entries.push({
        id: `m${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        kind, content: content.trim(), file, line,
        hits: 1, createdAt: Date.now(), updatedAt: Date.now(),
      });
      // 上限 500 条，超出按 hits 最低淘汰
      if (this.data.entries.length > 500) {
        this.data.entries.sort((a, b) => b.hits - a.hits);
        this.data.entries = this.data.entries.slice(0, 400);
      }
    }
    this.scheduleSave();
  }

  /** 记录一次会话 */
  noteSession() {
    this.data.stats.sessions++;
    this.scheduleSave();
  }

  noteFix() {
    this.data.stats.fixes++;
    this.scheduleSave();
  }

  noteIssue() {
    this.data.stats.issuesFound++;
    this.scheduleSave();
  }

  /* ---------------- 读取 ---------------- */
  /** 生成给 LLM 看的简要记忆（控制在合理长度内） */
  getBrief(workspace: string): string {
    const p = this.data.profile;
    const lines: string[] = [];

    const langs = Object.entries(p.languages).sort((a, b) => b[1] - a[1]).slice(0, 4);
    if (langs.length) {
      lines.push(`项目主要语言：${langs.map(([l, c]) => `${l}(${c}个文件)`).join('、')}`);
    }
    if (p.frameworks.length) lines.push(`技术栈：${p.frameworks.join('、')}`);
    if (p.tooling.length) lines.push(`工具链：${p.tooling.join('、')}`);

    const style: string[] = [];
    if (p.indent) style.push(`缩进 ${p.indent}`);
    if (p.quotes) style.push(`引号 ${p.quotes === 'single' ? '单引号' : '双引号'}`);
    if (p.semicolons !== undefined) style.push(p.semicolons ? '带分号' : '不带分号');
    if (p.commentLang) style.push(`注释 ${p.commentLang}`);
    if (style.length) lines.push(`代码风格：${style.join('、')} —— 生成代码时请遵循`);

    // 高频问题（命中多的排前面）
    const hot = this.data.entries
      .filter(e => e.kind === 'issue' || e.kind === 'fix')
      .sort((a, b) => b.hits - a.hits)
      .slice(0, 8);
    if (hot.length) {
      lines.push('');
      lines.push('历史问题与修复（供你参考，命中次数越高越常发生）：');
      for (const e of hot) {
        lines.push(`- ${e.file ? e.file + (e.line ? ':' + e.line : '') + ' ' : ''}${e.content}（×${e.hits}）`);
      }
    }

    // 术语表
    const terms = this.data.entries.filter(e => e.kind === 'term').slice(0, 12);
    if (terms.length) {
      lines.push('');
      lines.push('项目术语（保持用词一致）：');
      for (const t of terms) lines.push(`- ${t.content}`);
    }

    // 偏好
    const prefs = this.data.entries.filter(e => e.kind === 'preference').slice(0, 8);
    if (prefs.length) {
      lines.push('');
      lines.push('用户偏好：');
      for (const t of prefs) lines.push(`- ${t.content}`);
    }

    return lines.join('\n');
  }

  /** 完整数据（供 UI 展示/导出） */
  getAll(): MemoryData {
    return this.data;
  }

  clear() {
    this.data = { ...EMPTY, entries: [], stats: { ...EMPTY.stats } };
    this.save();
  }
}
