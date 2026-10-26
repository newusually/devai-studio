/* ============================================================================
 * renderer/components/SidePanel.tsx —— 右侧面板（代码 / 问题 / 文件 / Git / 工作室）
 * ========================================================================== */
import React, { useEffect, useState } from 'react';
import StudioPanel, { StudioTab } from './StudioPanel';

interface Props {
  tab: 'diag' | 'files' | 'git' | 'studio' | 'code';
  diagnostics: any[];
  workspace: string;
  codeView?: any; // ★改动文件查看器数据 {path,type,diff,before,after}
  onOpenSettings: () => void;
  onToast: (m: string) => void;
  onOpenFolder: (p: string) => void;
}

export default function SidePanel({ tab, diagnostics, workspace, codeView, onOpenSettings, onToast, onOpenFolder }: Props) {
  if (tab === 'diag') return <DiagPanel diagnostics={diagnostics} />;
  if (tab === 'files') return <FilesPanel workspace={workspace} />;
  if (tab === 'studio') {
    return <StudioShell onToast={onToast} onOpenFolder={onOpenFolder} />;
  }
  if (tab === 'code') return <CodePanel change={codeView} />;
  return <GitPanel workspace={workspace} onOpenSettings={onOpenSettings} />;
}

/* ---------------- ★代码/diff 查看器（点聊天里的改动文件打开） ---------------- */
function CodePanel({ change }: { change: any }) {
  if (!change) {
    return (
      <div className="panel-body">
        <div className="empty">
          <div className="empty-icon">{'</>'}</div>
          <div>还没有打开的改动</div>
          <div className="empty-sub">对话里 AI 修改文件后，点「在右侧查看」即可在这里看代码 diff</div>
        </div>
      </div>
    );
  }
  let add = 0, del = 0;
  const lines = String(change.diff || '').split('\n');
  for (const l of lines) {
    if (l.startsWith('+') && !l.startsWith('+++')) add++;
    else if (l.startsWith('-') && !l.startsWith('---')) del++;
  }
  let lineno = 0;
  return (
    <div className="panel-body code-panel">
      <div className="code-head">
        <div className="code-path" title={change.path}>
          {change.type === 'create' ? '➕ 新建' : change.type === 'delete' ? '➖ 删除' : '✏️ 修改'}
          ：{change.path}
        </div>
        <div className="code-stat">
          <b className="ds-add">+{add}</b>
          <b className="ds-del">−{del}</b>
        </div>
      </div>
      <div className="code-scroll">
        <div className="diff numbered">
          {lines.map((l: string, i: number) => {
            const cls = l.startsWith('+') && !l.startsWith('+++') ? 'dl-add'
              : l.startsWith('-') && !l.startsWith('---') ? 'dl-del'
                : l.startsWith('@@') ? 'dl-hunk' : 'dl-ctx';
            if (cls === 'dl-add' || cls === 'dl-ctx') lineno++;
            const no = (cls === 'dl-del') ? '' : String(lineno);
            return (
              <div className={'dl ' + cls} key={i}>
                <span className="dl-no">{no}</span>
                <span className="dl-code">{l || ' '}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 问题面板 ---------------- */
/* ★2026-10-26：默认只显示真正的"问题"（错误+警告），info 提示单独归一类，
 *   免得 no-var/no-console 这类低价值提示让右栏看起来"全是警告"。 */
type FilterKey = 'issue' | 'error' | 'warning' | 'info';
function DiagPanel({ diagnostics }: { diagnostics: any[] }) {
  const [filter, setFilter] = useState<FilterKey>('issue');
  const isIssue = (d: any) => d.severity === 'error' || d.severity === 'warning';
  const list = diagnostics.filter(d =>
    filter === 'issue' ? isIssue(d) : d.severity === filter);

  const counts = {
    issue: diagnostics.filter(isIssue).length,
    error: diagnostics.filter(d => d.severity === 'error').length,
    warning: diagnostics.filter(d => d.severity === 'warning').length,
    info: diagnostics.filter(d => d.severity === 'info').length,
  };

  return (
    <div className="panel-body">
      <div className="filter-row">
        {([
          { k: 'issue', label: `问题 ${counts.issue}` },
          { k: 'error', label: `错误 ${counts.error}` },
          { k: 'warning', label: `警告 ${counts.warning}` },
          { k: 'info', label: `提示 ${counts.info}` },
        ] as Array<{ k: FilterKey; label: string }>).map(f => (
          <button
            key={f.k}
            className={`chip ${filter === f.k ? 'on' : ''} ${f.k}`}
            onClick={() => setFilter(f.k)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {list.length === 0 ? (
        <div className="empty">
          {counts.issue === 0 ? (
            <>
              <div className="empty-icon">✓</div>
              <div>没有发现错误或警告</div>
              <div className="empty-sub">工作区代码干净 · 启动时已自动检查当前工作区</div>
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


/* ---------------- 工作室外壳（内部再分标签） ---------------- */
function StudioShell({ onToast, onOpenFolder }: { onToast: (m: string) => void; onOpenFolder: (p: string) => void }) {
  const [sub, setSub] = useState<StudioTab>('engine');
  const TABS: Array<{ id: StudioTab; name: string }> = [
    { id: 'engine', name: '引擎' },
    { id: 'media', name: '媒体' },
    { id: 'doc', name: '文档' },
    { id: 'excel', name: '表格' },
    { id: 'batch', name: '批量' },
  ];
  return (
    <div className="studio-shell">
      <div className="studio-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`stab ${sub === t.id ? 'on' : ''}`}
            onClick={() => setSub(t.id)}>{t.name}</button>
        ))}
      </div>
      <div className="studio-body">
        <StudioPanel tab={sub} onToast={onToast} onOpenFolder={onOpenFolder} />
      </div>
    </div>
  );
}
