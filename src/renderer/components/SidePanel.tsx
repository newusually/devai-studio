/* ============================================================================
 * renderer/components/SidePanel.tsx —— 右侧面板（问题 / 文件 / Git）
 * ========================================================================== */
import React, { useEffect, useState } from 'react';

interface Props {
  tab: 'diag' | 'files' | 'git';
  diagnostics: any[];
  workspace: string;
  onOpenSettings: () => void;
}

export default function SidePanel({ tab, diagnostics, workspace, onOpenSettings }: Props) {
  if (tab === 'diag') return <DiagPanel diagnostics={diagnostics} />;
  if (tab === 'files') return <FilesPanel workspace={workspace} />;
  return <GitPanel workspace={workspace} onOpenSettings={onOpenSettings} />;
}

/* ---------------- 问题面板 ---------------- */
function DiagPanel({ diagnostics }: { diagnostics: any[] }) {
  const [filter, setFilter] = useState<'all' | 'error' | 'warning' | 'info'>('all');
  const list = diagnostics.filter(d => filter === 'all' || d.severity === filter);

  const counts = {
    error: diagnostics.filter(d => d.severity === 'error').length,
    warning: diagnostics.filter(d => d.severity === 'warning').length,
    info: diagnostics.filter(d => d.severity === 'info').length,
  };

  return (
    <div className="panel-body">
      <div className="filter-row">
        {(['all', 'error', 'warning', 'info'] as const).map(f => (
          <button
            key={f}
            className={`chip ${filter === f ? 'on' : ''} ${f}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? `全部 ${diagnostics.length}` :
              f === 'error' ? `错误 ${counts.error}` :
                f === 'warning' ? `警告 ${counts.warning}` : `提示 ${counts.info}`}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {diagnostics.length === 0 ? (
            <>
              <div className="empty-icon">✓</div>
              <div>没有发现问题</div>
              <div className="empty-sub">点击顶部「工具 → 扫描工作区问题」或直接和 AI 对话</div>
            </>
          ) : (
            <div>该分类下没有问题</div>
          )}
        </div>
      ) : (
        <div className="diag-list">
          {list.map((d, i) => (
            <div className={`diag ${d.severity}`} key={i}>
              <div className="diag-head">
                <span className="diag-sev">{sevIcon(d.severity)}</span>
                <span className="diag-msg">{d.message}</span>
              </div>
              <div className="diag-loc">
                {d.file || '(未知文件)'}:{d.line}:{d.column}
                {d.ruleId && <span className="diag-rule">{d.ruleId}</span>}
              </div>
              {d.snippet && <div className="diag-snippet">{d.snippet}</div>}
              {d.suggestion && <div className="diag-fix">💡 {d.suggestion}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function sevIcon(s: string): string {
  return s === 'error' ? '✕' : s === 'warning' ? '⚠' : 'ℹ';
}

/* ---------------- 文件面板 ---------------- */
function FilesPanel({ workspace }: { workspace: string }) {
  const [entries, setEntries] = useState<any[]>([]);
  const [path, setPath] = useState('.');

  const load = async (p: string) => {
    const r = await window.api.file.tree(p);
    if (r?.ok) {
      setEntries(r.data.entries);
      setPath(p);
    }
  };

  useEffect(() => { load('.'); }, []);

  return (
    <div className="panel-body">
      <div className="file-bar">
        <button className="link-btn" onClick={() => load('.')}>🏠</button>
        <span className="file-path" title={workspace}>{path === '.' ? '工作区根目录' : path}</span>
      </div>
      <div className="file-list">
        {path !== '.' && (
          <div className="file-item dir" onClick={() => {
            const parts = path.split('/').filter(Boolean);
            parts.pop();
            load(parts.join('/') || '.');
          }}>
            <span>📁</span><span>..</span>
          </div>
        )}
        {entries.map((e: any) => (
          <div
            className={`file-item ${e.type}`}
            key={e.name}
            onClick={() => {
              if (e.type === 'dir') load(path === '.' ? e.name : `${path}/${e.name}`);
            }}
          >
            <span>{e.type === 'dir' ? '📁' : '📄'}</span>
            <span className="fname">{e.name}</span>
            {e.type === 'file' && <span className="fsize">{fmtSize(e.size)}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

function fmtSize(n: number): string {
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'K';
  return (n / 1048576).toFixed(1) + 'M';
}

/* ---------------- Git 面板 ---------------- */
function GitPanel({ workspace, onOpenSettings }: { workspace: string; onOpenSettings: () => void }) {
  const [status, setStatus] = useState<any>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const refresh = async () => {
    const s = await window.api.git.status();
    setStatus(s);
  };

  useEffect(() => { refresh(); }, []);

  const add = (t: string) => setLog(l => [t, ...l].slice(0, 50));

  const doInit = async () => {
    setBusy(true);
    const r = await window.api.git.init();
    add(r.ok ? '✓ 已初始化 Git 仓库' : `✗ ${r.error}`);
    await refresh();
    setBusy(false);
  };

  const doCommit = async () => {
    if (!msg.trim()) return;
    setBusy(true);
    const r = await window.api.git.commit(msg);
    add(r.ok ? `✓ 提交成功\n${r.stdout || ''}` : `✗ ${r.error || r.stderr}`);
    if (r.ok) setMsg('');
    await refresh();
    setBusy(false);
  };

  const doPush = async () => {
    setBusy(true);
    const r = await window.api.git.push();
    add(r.ok ? `✓ 推送成功\n${r.stdout || ''}` : `✗ ${r.error || r.stderr}\n\n若还没有远程仓库，请先在 GitHub 创建空仓库，然后在设置里填写地址。`);
    setBusy(false);
  };

  const isRepo = status?.ok;

  return (
    <div className="panel-body">
      {!isRepo ? (
        <div className="empty">
          <div className="empty-icon">📦</div>
          <div>当前工作区不是 Git 仓库</div>
          <button className="btn-primary" onClick={doInit} disabled={busy}>
            初始化 Git 仓库
          </button>
          <div className="empty-sub">初始化后即可提交代码并推送到 GitHub</div>
        </div>
      ) : (
        <>
          <div className="git-head">
            <span className="git-branch">⑂ {status.branch}</span>
            <button className="link-btn" onClick={refresh}>刷新</button>
          </div>

          <div className="git-files">
            {status.files.length === 0 ? (
              <div className="git-clean">工作区干净，没有未提交的更改</div>
            ) : (
              status.files.map((f: any, i: number) => (
                <div className="git-file" key={i}>
                  <span className={`gst ${f.status}`}>{f.status}</span>
                  <span className="gpath">{f.path}</span>
                </div>
              ))
            )}
          </div>

          <div className="git-commit">
            <textarea
              value={msg}
              onChange={e => setMsg(e.target.value)}
              placeholder="提交信息…"
              rows={2}
            />
            <div className="git-btns">
              <button className="btn-ok" onClick={doCommit} disabled={busy || !msg.trim()}>提交</button>
              <button className="btn-ghost" onClick={doPush} disabled={busy}>推送到 GitHub</button>
            </div>
          </div>

          {log.length > 0 && (
            <div className="git-log">
              {log.map((l, i) => <pre key={i}>{l}</pre>)}
            </div>
          )}
        </>
      )}
    </div>
  );
}
