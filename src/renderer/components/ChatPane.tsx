/* ============================================================================
 * renderer/components/ChatPane.tsx —— 对话面板
 * ----------------------------------------------------------------------------
 * 能力：
 *   · 流式输出（token 级）
 *   · Markdown + 代码高亮
 *   · 工具调用可视化（读了哪个文件、执行了什么命令）
 *   · 修复提案的 diff 视图 + 应用/回滚按钮
 *   · 每条回复标注【用的哪个模型 + 耗时】—— 满足"写清楚模型"
 * ========================================================================== */
import React, { useEffect, useRef, useState } from 'react';
import { Msg } from '../App';

interface Props {
  messages: Msg[];
  streaming: boolean;
  sessionId: string;
  currentModel?: string;
  models?: any[];
  recommended?: any[]; // 推荐清单（含 light 残血版），补全下拉里未下载的模型
  onModelChange?: (model: string, isUninstalled?: boolean) => void;
  fontScale?: number;
  onSend: (text: string) => void;
  onAbort: () => void;
  onApplyPatch: (patch: any) => Promise<any>;
  onRejectPatch: () => Promise<void>;
  onOpenFile?: (change: any) => void; // ★点改动文件 → 右侧代码查看器
}

/* ---------------- 用时格式化 / 计时器 ---------------- */
export function formatDur(ms?: number): string {
  if (ms == null || isNaN(ms)) return '';
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}秒`;
  const m = Math.floor(s / 60);
  return `${m}分${Math.round(s - m * 60)}秒`;
}

/* ★实时计时器：streaming 期间每秒跳动（对齐 WorkBuddy"用时几分几秒"） */
function ElapsedTimer({ start, running }: { start: number; running: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [running]);
  const ms = (running ? now : now) - start;
  if (ms < 0) return null;
  return <span className={`timer ${running ? 'run' : ''}`}>⏱ {formatDur(Math.max(0, ms))}{running ? '' : ' 完成'}</span>;
}

/* ---------------- diff 行数统计（+N / -M） ---------------- */
function diffStats(diff?: string): { add: number; del: number } {
  let add = 0, del = 0;
  for (const l of (diff || '').split('\n')) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  return { add, del };
}

/* ---------------- 极简 Markdown 渲染 ----------------
 * 不引入 markdown 依赖（减小体积、加快启动）：
 * 支持标题、列表、代码块、行内代码、粗体、链接 */
function renderMarkdown(src: string): React.ReactNode {
  const lines = src.split('\n');
  const out: React.ReactNode[] = [];
  let inCode = false;
  let codeLang = '';
  let codeBuf: string[] = [];

  const flushCode = (key: string) => {
    if (codeBuf.length) {
      out.push(
        <pre className="code-block" key={key}>
          <div className="code-lang">{codeLang || 'text'}</div>
          <code>{highlight(codeBuf.join('\n'), codeLang)}</code>
        </pre>
      );
      codeBuf = [];
    }
  };

  lines.forEach((line, i) => {
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      if (inCode) {
        flushCode(`c${i}`);
        inCode = false;
        codeLang = '';
      } else {
        inCode = true;
        codeLang = fence[1] || '';
      }
      return;
    }
    if (inCode) { codeBuf.push(line); return; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const Tag = `h${Math.min(lvl + 2, 6)}` as any;
      out.push(<Tag key={i}>{inline(h[2])}</Tag>);
      return;
    }
    // 列表
    const li = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (li) {
      const indent = Math.floor(li[1].length / 2);
      out.push(
        <div className="li" key={i} style={{ paddingLeft: indent * 16 }}>
          <span className="li-dot">•</span><span>{inline(li[2])}</span>
        </div>
      );
      return;
    }
    // 有序列表
    const ol = line.match(/^(\s*)(\d+)\.\s+(.*)$/);
    if (ol) {
      out.push(
        <div className="li" key={i}>
          <span className="li-num">{ol[2]}.</span><span>{inline(ol[3])}</span>
        </div>
      );
      return;
    }
    // 引用
    if (line.startsWith('> ')) {
      out.push(<div className="quote" key={i}>{inline(line.slice(2))}</div>);
      return;
    }
    // 分隔线
    if (/^---+$/.test(line.trim())) {
      out.push(<hr key={i} />);
      return;
    }
    if (!line.trim()) { out.push(<div className="sp" key={i} />); return; }
    out.push(<p key={i}>{inline(line)}</p>);
  });

  if (inCode) flushCode('cend');
  return out;
}

/* ---------------- 行内标记 ---------------- */
function inline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith('`')) {
      parts.push(<code className="inline-code" key={k++}>{t.slice(1, -1)}</code>);
    } else if (t.startsWith('**')) {
      parts.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    } else {
      const lm = t.match(/\[([^\]]+)\]\(([^)]+)\)/);
      if (lm) {
        parts.push(<a key={k++} href={lm[2]} target="_blank" rel="noreferrer">{lm[1]}</a>);
      }
    }
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

/* ---------------- 简易语法高亮 ---------------- */
const KEYWORDS: Record<string, string[]> = {
  javascript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'await', 'async', 'class', 'import', 'export', 'from', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'instanceof', 'of', 'in', 'this', 'null', 'undefined', 'true', 'false', 'break', 'continue', 'switch', 'case', 'default', 'extends', 'super'],
  typescript: ['const', 'let', 'var', 'function', 'return', 'if', 'else', 'for', 'while', 'await', 'async', 'class', 'interface', 'type', 'enum', 'import', 'export', 'from', 'new', 'try', 'catch', 'finally', 'throw', 'typeof', 'implements', 'public', 'private', 'protected', 'readonly', 'as', 'null', 'undefined', 'true', 'false'],
  python: ['def', 'class', 'return', 'if', 'elif', 'else', 'for', 'while', 'import', 'from', 'as', 'with', 'try', 'except', 'finally', 'raise', 'lambda', 'yield', 'async', 'await', 'pass', 'break', 'continue', 'None', 'True', 'False', 'and', 'or', 'not', 'in', 'is', 'global', 'nonlocal', 'self'],
  go: ['func', 'package', 'import', 'return', 'if', 'else', 'for', 'range', 'var', 'const', 'type', 'struct', 'interface', 'map', 'chan', 'go', 'defer', 'switch', 'case', 'default', 'break', 'continue', 'nil', 'true', 'false'],
  bash: ['if', 'then', 'else', 'fi', 'for', 'do', 'done', 'while', 'case', 'esac', 'function', 'return', 'export', 'local', 'echo', 'cd', 'set'],
  sql: ['SELECT', 'FROM', 'WHERE', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'TABLE', 'INDEX', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON', 'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'AND', 'OR', 'NOT', 'AS', 'PRIMARY', 'KEY', 'UNIQUE', 'DEFAULT'],
};

function highlight(code: string, lang: string): React.ReactNode {
  const kw = KEYWORDS[lang.toLowerCase()] || KEYWORDS.javascript;
  const kwSet = new Set(kw);
  const parts = code.split(/(\s+|[(){}[\].,;:?!<>=+\-*/&|^%]+|#[^\n]*|\/\/[^\n]*|"[^"\n]*"|'[^'\n]*`|`[^`]*`)/g);

  return parts.map((p, i) => {
    if (!p) return null;
    if (/^\s+$/.test(p)) return <span key={i}>{p}</span>;
    if (/^[(){}[\].,;:?!<>=+\-*/&|^%]+$/.test(p)) return <span className="tk-punc" key={i}>{p}</span>;
    if (p.startsWith('//') || p.startsWith('#')) return <span className="tk-comment" key={i}>{p}</span>;
    if (/^["'`]/.test(p)) return <span className="tk-str" key={i}>{p}</span>;
    if (/^\d/.test(p)) return <span className="tk-num" key={i}>{p}</span>;
    if (kwSet.has(p)) return <span className="tk-kw" key={i}>{p}</span>;
    if (/^[A-Z][A-Za-z0-9_]*$/.test(p)) return <span className="tk-type" key={i}>{p}</span>;
    return <span key={i}>{p}</span>;
  });
}

/* ---------------- diff 视图 ---------------- */
function DiffView({ diff }: { diff: string }) {
  const lines = (diff || '').split('\n');
  return (
    <div className="diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+') && !l.startsWith('+++') ? 'dl-add'
          : l.startsWith('-') && !l.startsWith('---') ? 'dl-del'
            : l.startsWith('@@') ? 'dl-hunk' : 'dl-ctx';
        return <div className={'dl ' + cls} key={i}>{l || ' '}</div>;
      })}
    </div>
  );
}

/* ---------------- 主组件 ---------------- */
export default function ChatPane({ messages, streaming, onSend, onAbort, onApplyPatch, onRejectPatch, onOpenFile, currentModel = '', models = [], recommended = [], onModelChange, fontScale = 1 }: Props) {
  const [input, setInput] = useState('');
  const [applied, setApplied] = useState<Record<string, boolean>>({});
  const [flash, setFlash] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(''), 1800);
    return () => clearTimeout(t);
  }, [flash]);

  const copyText = (text: string) => {
    navigator.clipboard?.writeText(text || '').then(() => setFlash('已复制到剪贴板')).catch(() => setFlash('复制失败'));
  };
  const forwardText = (text: string) => {
    navigator.clipboard?.writeText(text || '').then(() => setFlash('已复制，可粘贴到任意会话完成转发')).catch(() => setFlash('复制失败'));
  };

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  /* ★输入框随内容自动增高（对齐"对话框太小"反馈） */
  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 320) + 'px';
    }
  }, [input]);

  const submit = () => {
    const t = input.trim();
    if (!t || streaming) return;
    setInput('');
    onSend(t);
  };

  return (
    <div className="chat" style={{ fontSize: `${fontScale}em` } as React.CSSProperties}>
      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="welcome">
            <div className="welcome-logo">D</div>
            <h1>DevAI Studio</h1>
            <p className="welcome-sub">免费开源的本地 AI 编程助手</p>
            <div className="welcome-tips">
              <div className="tip"><b>检查代码问题</b><span>扫描工作区，找出语法错误、未使用变量、缺失导入等问题</span></div>
              <div className="tip"><b>解释一段代码</b><span>选中文件后让我说明它的作用和潜在风险</span></div>
              <div className="tip"><b>修复并应用</b><span>我会给出 diff，你确认后才写入磁盘</span></div>
            </div>
          </div>
        )}

        {messages.map(m => (
          <div className={`msg ${m.role}`} key={m.id}>
            <div className="msg-avatar">{m.role === 'user' ? '你' : 'AI'}</div>
            <div className="msg-body">
              {m.role === 'user' ? (
                <div className="user-text">{m.content}</div>
              ) : (
                <>
                  {m.toolCalls && m.toolCalls.length > 0 && (
                    <div className="tool-list">
                      {/* ★执行过程标题行：步骤数 + 总用时（streaming 时实时跳动） */}
                      <div className="tool-head">
                        <span>📋 执行过程 · {m.toolCalls.length} 步</span>
                        {m.streaming
                          ? <ElapsedTimer start={m.ts} running />
                          : (m.totalMs != null && <span className="timer">⏱ 用时 {formatDur(m.totalMs)}</span>)}
                      </div>
                      {m.toolCalls.map((t: any, i: number) => (
                        <div className={`tool ${t.ok === false ? 'err' : t.ok ? 'ok' : 'run'}`} key={t.callId || i}>
                          <details className="tool-detail">
                            <summary>
                              <span className="tool-icon">
                                {t.ok === false ? '✕' : t.ok ? '✓' : '⏳'}
                              </span>
                              <span className="tool-name">{toolLabel(t.name)}</span>
                              <span className="tool-args">{toolArgs(t)}</span>
                              {t.durationMs != null && <span className="tool-dur">{formatDur(t.durationMs)}</span>}
                            </summary>
                            {/* ★展开看真实输出：运行了什么程序、校验结果、读了什么 */}
                            {t.text && (
                              <pre className="tool-out">{String(t.text).slice(0, 1500)}{String(t.text).length > 1500 ? '\n…（输出过长已截断）' : ''}</pre>
                            )}
                          </details>
                        </div>
                      ))}
                    </div>
                  )}

                  {m.content && <div className="md">{renderMarkdown(m.content)}</div>}

                  {/* ★处理过程提示：实时状态行 + 转圈（对齐 WorkBuddy），绝不只剩空白气泡 */}
                  {m.streaming && !m.content && (!m.toolCalls || m.toolCalls.length === 0) && (
                    <div className="status-line">
                      <span className="spinner" />
                      <span>{m.status || '🤖 正在思考…'}</span>
                      <ElapsedTimer start={m.ts} running />
                    </div>
                  )}

                  {/* ★思考过程卡片：Qwen3 thinking 实时流式展示、可折叠
                      （对齐龙虾"推理流渲染——思考过程以引用块实时显示在同一张卡片中"） */}
                  {m.thinking && (
                    <details className="think-card" open={!!m.streaming && !m.content}>
                      <summary>💭 思考过程{m.streaming ? ' · 实时' : ''}</summary>
                      <div className="think-body">{m.thinking}</div>
                    </details>
                  )}

                  {m.streaming && <span className="cursor">▍</span>}

                  {m.patch && (
                    <div className="patch">
                      <div className="patch-head">
                        <span className="patch-title">🔧 修复提案：{m.patch.title}</span>
                        <span className={`risk risk-${m.patch.risk}`}>
                          {m.patch.risk === 'low' ? '低风险' : m.patch.risk === 'medium' ? '中风险' : '高风险'}
                        </span>
                      </div>
                      {m.patch.explanation && (
                        <div className="patch-desc">{m.patch.explanation}</div>
                      )}
                      {m.patch.changes?.map((c: any, i: number) => {
                        const st = diffStats(c.diff);
                        return (
                          <div key={i} className="patch-file">
                            <div className="patch-path">
                              {c.type === 'create' ? '➕ 新建' : c.type === 'delete' ? '➖ 删除' : '✏️ 修改'} {c.path}
                              {/* ★加/减行数徽标（WorkBuddy 同款） */}
                              {(st.add > 0 || st.del > 0) && (
                                <span className="dstats">
                                  <b className="ds-add">+{st.add}</b>
                                  {st.del > 0 && <b className="ds-del">−{st.del}</b>}
                                </span>
                              )}
                              {/* ★点文件名 → 右侧边栏看代码 diff */}
                              <button className="patch-open" onClick={() => onOpenFile?.(c)}
                                title="在右侧面板查看代码改动">在右侧查看 ›</button>
                            </div>
                            <DiffView diff={c.diff || ''} />
                          </div>
                        );
                      })}
                      <div className="patch-actions">
                        {!applied[m.patch.id] ? (
                          <>
                            <button className="btn-ok" onClick={async () => {
                              const r = await onApplyPatch(m.patch);
                              if (r?.ok) setApplied(p => ({ ...p, [m.patch.id]: true }));
                            }}>✓ 应用修改</button>
                            <button className="btn-ghost" onClick={() => onRejectPatch()}>✕ 放弃</button>
                          </>
                        ) : (
                          <span className="applied-tag">✓ 已应用到磁盘</span>
                        )}
                      </div>
                    </div>
                  )}

                  {(m.model || m.ts) && !m.streaming && (
                    <div className="msg-meta">
                      {m.model && <span className="meta-model">🤖 {m.model}</span>}
                      {m.totalMs != null && <span className="meta-dur">⏱ 用时 {formatDur(m.totalMs)}</span>}
                      <span className="meta-time">{new Date(m.ts).toLocaleTimeString('zh-CN')}</span>
                    </div>
                  )}
                </>
              )}
              {/* ★复制 / 转发（WorkBuddy 同款） */}
              <div className="msg-actions">
                <button className="msg-act" onClick={() => copyText(m.content)}>复制</button>
                <button className="msg-act" onClick={() => forwardText(m.content)}>转发</button>
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="composer">
        <div className="composer-box">
          <textarea
            id="chat-input"
            ref={inputRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="描述你的需求，或让我检查代码…（Enter 发送，Shift+Enter 换行）"
            rows={1}
          />
          <div className="composer-actions">
            {/* ★WorkBuddy 风格：对话内直接切换模型，无需进设置 */}
            <select
              className="model-select"
              value={currentModel}
              onChange={e => {
                const opt = e.target.selectedOptions?.[0];
                const uninst = opt?.dataset?.need === '1';
                onModelChange?.(e.target.value, uninst);
              }}
              title="切换模型（未下载的会先自动下载）"
            >
              {!models.some(m => m.id === currentModel) && currentModel && (
                <option value={currentModel}>{currentModel}（当前）</option>
              )}
              {/* 已安装模型 */}
              {models.map(m => (
                <option key={'i_' + m.id} value={m.id}>
                  {m.id}{m.size ? ` · ${m.size}` : ''}
                </option>
              ))}
              {/* 推荐但未下载的（含残血版），选中即下载 */}
              {recommended
                .filter(r => !models.some(m => m.id === r.name))
                .map(r => {
                  const lname = r.light || r.name;
                  const showName = lname === r.name ? r.name : `${r.name}（一键下残血 ${lname}）`;
                  return (
                    <option key={'rec_' + lname} value={lname} data-need="1">
                      {showName} · 未下载
                    </option>
                  );
                })}
              {models.length === 0 && !currentModel && recommended.length === 0 && (
                <option value="">（无可用模型）</option>
              )}
            </select>
            {streaming ? (
              <button className="btn-stop" onClick={onAbort}>■ 停止</button>
            ) : (
              <button className="btn-send" onClick={submit} disabled={!input.trim()}>发送 ↑</button>
            )}
          </div>
        </div>
        <div className="composer-hint">
          本地模型完全免费且离线可用 · 代码分析不消耗任何模型额度 · 可在输入框左侧随时切换模型
        </div>
        {streaming && <div className="composer-status">🤖 正在处理…（可点「停止」中断）</div>}
      </div>
      {flash && <div className="toast">{flash}</div>}
    </div>
  );
}

function toolLabel(name: string): string {
  const map: Record<string, string> = {
    read_file: '读取文件',
    write_file: '写入文件',
    list_dir: '列出目录',
    search_code: '搜索代码',
    analyze_file: '静态分析',
    apply_patch: '应用补丁',
    run_command: '执行命令',
    detect_project: '识别项目',
    verify_project: '验证构建',
    check_env: '环境探测',
    fetch_url: '下载文件',
    browser_open: '无头浏览器',
    git_status: 'Git 状态',
    git_commit: 'Git 提交',
    git_diff: 'Git 差异',
  };
  return map[name] || name;
}

function toolArgs(t: { name: string; args: any }): string {
  const a = t.args || {};
  if (a.path) return a.path;
  if (a.pattern) return `/${a.pattern}/`;
  if (a.command) return a.command;
  if (a.message) return a.message;
  return '';
}
