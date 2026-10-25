/* ============================================================================
 * main/store.ts —— 会话持久化（node:sqlite）
 * ----------------------------------------------------------------------------
 * 与 WorkBuddy 一致的技术选型：Node 内置 sqlite，零外部依赖、零安装成本。
 *
 * 表结构：
 *   sessions   —— 会话元信息
 *   messages   —— 对话消息（含模型标识，用于"这次是哪个模型答的"）
 *   diagnostics—— 每轮分析产生的诊断
 *   changes    —— 文件修改历史（可回滚）
 * ========================================================================== */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatMessage, Session, SessionDetail, Diagnostic, FileChange } from '../shared/types';

export class SessionStore {
  private db: DatabaseSync;
  private path: string;

  constructor(dataDir: string) {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    this.path = join(dataDir, 'devai.db');
    this.db = new DatabaseSync(this.path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.init();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id        TEXT PRIMARY KEY,
        title     TEXT NOT NULL DEFAULT '新会话',
        createdAt INTEGER NOT NULL,
        updatedAt INTEGER NOT NULL,
        workspace TEXT,
        preview   TEXT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        role      TEXT NOT NULL,
        content   TEXT NOT NULL,
        model     TEXT,
        provider  TEXT,
        ts        INTEGER NOT NULL,
        toolCall  TEXT,
        usage     TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(sessionId, id);
      CREATE TABLE IF NOT EXISTS diagnostics (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        file      TEXT NOT NULL,
        line      INTEGER NOT NULL,
        severity  TEXT NOT NULL,
        ruleId    TEXT,
        message   TEXT NOT NULL,
        suggestion TEXT,
        payload   TEXT,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_diag_session ON diagnostics(sessionId, id);
      CREATE TABLE IF NOT EXISTS changes (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        sessionId TEXT NOT NULL,
        path      TEXT NOT NULL,
        type      TEXT NOT NULL,
        before    TEXT,
        after     TEXT,
        diff      TEXT,
        applied   INTEGER NOT NULL DEFAULT 0,
        ts        INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chg_session ON changes(sessionId, id);
    `);
  }

  /* ---------------- 会话 ---------------- */
  createSession(title = '新会话', workspace?: string): Session {
    const id = randomUUID();
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO sessions (id, title, createdAt, updatedAt, workspace) VALUES (?,?,?,?,?)'
    ).run(id, title, now, now, workspace || null);
    return { id, title, createdAt: now, updatedAt: now, workspace, messageCount: 0 };
  }

  listSessions(limit = 100): Session[] {
    const rows = this.db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM messages m WHERE m.sessionId = s.id) AS cnt
       FROM sessions s ORDER BY s.updatedAt DESC LIMIT ?`
    ).all(limit) as any[];
    return rows.map(r => ({
      id: r.id,
      title: r.title,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      workspace: r.workspace || undefined,
      messageCount: r.cnt || 0,
      preview: r.preview || undefined,
    }));
  }

  getSession(id: string): SessionDetail | null {
    const s = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!s) return null;
    const msgs = this.db.prepare(
      'SELECT * FROM messages WHERE sessionId = ? ORDER BY id ASC'
    ).all(id) as any[];
    const diags = this.db.prepare(
      'SELECT payload FROM diagnostics WHERE sessionId = ? ORDER BY id ASC'
    ).all(id) as any[];
    const chgs = this.db.prepare(
      'SELECT * FROM changes WHERE sessionId = ? ORDER BY id ASC'
    ).all(id) as any[];

    const models = [...new Set(msgs.map(m => m.model).filter(Boolean))] as string[];

    return {
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      workspace: s.workspace || undefined,
      messageCount: msgs.length,
      models,
      messages: msgs.map(m => ({
        role: m.role,
        content: m.content,
        model: m.model || undefined,
        provider: m.provider || undefined,
        ts: m.ts,
        toolCall: m.toolCall ? JSON.parse(m.toolCall) : undefined,
        usage: m.usage ? JSON.parse(m.usage) : undefined,
      })),
      diagnostics: diags.map(d => JSON.parse(d.payload) as Diagnostic),
      changes: chgs.map(c => ({
        path: c.path, type: c.type, before: c.before || undefined,
        after: c.after || undefined, diff: c.diff || undefined,
        applied: !!c.applied, ts: c.ts,
      })),
    };
  }

  deleteSession(id: string): boolean {
    this.db.prepare('DELETE FROM messages WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM diagnostics WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM changes WHERE sessionId = ?').run(id);
    const r = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
    return r.changes > 0;
  }

  renameSession(id: string, title: string): boolean {
    const r = this.db.prepare(
      'UPDATE sessions SET title = ?, updatedAt = ? WHERE id = ?'
    ).run(title, Date.now(), id);
    return r.changes > 0;
  }

  touch(id: string, preview?: string) {
    this.db.prepare('UPDATE sessions SET updatedAt = ?, preview = COALESCE(?, preview) WHERE id = ?')
      .run(Date.now(), preview || null, id);
  }

  /* ---------------- 消息 ---------------- */
  addMessage(sessionId: string, msg: ChatMessage): void {
    this.db.prepare(
      'INSERT INTO messages (sessionId, role, content, model, provider, ts, toolCall, usage) VALUES (?,?,?,?,?,?,?,?)'
    ).run(
      sessionId, msg.role, msg.content,
      msg.model || null, msg.provider || null,
      msg.ts || Date.now(),
      msg.toolCall ? JSON.stringify(msg.toolCall) : null,
      msg.usage ? JSON.stringify(msg.usage) : null
    );
    this.touch(sessionId, msg.content.slice(0, 120));
  }

  /* ---------------- 诊断 ---------------- */
  addDiagnostics(sessionId: string, diags: Diagnostic[], file?: string): void {
    const st = this.db.prepare(
      'INSERT INTO diagnostics (sessionId, file, line, severity, ruleId, message, suggestion, payload, ts) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const now = Date.now();
    for (const d of diags) {
      st.run(sessionId, d.file || file || '', d.line, d.severity,
        d.ruleId || null, d.message, d.suggestion || null, JSON.stringify(d), now);
    }
  }

  /* ---------------- 文件修改 ---------------- */
  addChange(sessionId: string, c: FileChange): void {
    this.db.prepare(
      'INSERT INTO changes (sessionId, path, type, before, after, diff, applied, ts) VALUES (?,?,?,?,?,?,?,?)'
    ).run(sessionId, c.path, c.type, c.before || null, c.after || null,
      c.diff || null, c.applied ? 1 : 0, c.ts || Date.now());
  }

  getChangeBefore(sessionId: string, path: string): string | undefined {
    const r = this.db.prepare(
      'SELECT before FROM changes WHERE sessionId = ? AND path = ? ORDER BY id DESC LIMIT 1'
    ).get(sessionId, path) as any;
    return r?.before ?? undefined;
  }

  close() {
    try { this.db.close(); } catch (e) { }
  }
}
