/* ============================================================================
 * renderer/components/AgentBar.tsx —— 角色选择器 + 模型管理 + 学习面板
 * ----------------------------------------------------------------------------
 * 三个功能合一放在左栏顶部：
 *   ① 角色（Agent）选择 —— 13 种专业角色
 *   ② 模型管理 —— 一键下载本地免费模型（含英文模型）
 *   ③ 自动学习 —— 展示已积累的项目知识
 * ========================================================================== */
import React, { useEffect, useState } from 'react';

interface Props {
  currentModel: string;
  onRoleChange: (id: string) => void;
  onToast: (msg: string) => void;
}

export default function AgentBar({ currentModel, onRoleChange, onToast }: Props) {
  const [roles, setRoles] = useState<any[]>([]);
  const [roleId, setRoleId] = useState('general');
  const [showModels, setShowModels] = useState(false);
  const [showMem, setShowMem] = useState(false);
  const [installed, setInstalled] = useState<string[]>([]);
  const [recs, setRecs] = useState<any[]>([]);
  const [pulling, setPulling] = useState('');
  const [mem, setMem] = useState<any>(null);

  useEffect(() => {
    window.api.role.list().then(setRoles).catch(() => { });
    window.api.model.recommend().then((r: any) => setRecs(r?.models || [])).catch(() => { });
    refreshInstalled();
    loadMem();
  }, []);

  const refreshInstalled = async () => {
    try {
      const r = await window.api.model.list('ollama');
      const found = r.find(x => x.kind === 'ollama');
      setInstalled((found?.models || []).map((m: any) => m.id));
    } catch (e) { }
  };

  const loadMem = async () => {
    try {
      const r = await window.api.memory.get();
      setMem(r.memory);
    } catch (e) { }
  };

  const pickRole = async (id: string) => {
    setRoleId(id);
    await window.api.role.set(id);
    const r = roles.find(x => x.id === id);
    onToast(`已切换到「${r?.name || id}」`);
  };

  const pull = async (name: string) => {
    setPulling(name);
    onToast(`正在下载 ${name}，请稍候…`);
    try {
      const r = await window.api.model.pull(name);
      if (r.ok) {
        onToast(`✓ ${name} 下载完成`);
        refreshInstalled();
      } else {
        onToast(`✗ ${name} 下载失败：${r.error || ''}`);
      }
    } catch (e: any) {
      onToast('✗ 下载异常：' + (e?.message || e));
    }
    setPulling('');
  };

  const cur = roles.find(r => r.id === roleId);

  return (
    <>
      {/* ① 角色选择 */}
      <div className="agent-box">
        <div className="ws-label">AI 角色 / Agent</div>
        <select className="role-select" value={roleId} onChange={e => pickRole(e.target.value)}>
          {roles.map(r => (
            <option key={r.id} value={r.id}>{r.icon} {r.name}</option>
          ))}
        </select>
        {cur && <div className="role-desc">{cur.desc}</div>}

        <div className="agent-links">
          <button className="link-btn" onClick={() => { setShowModels(v => !v); setShowMem(false); }}>
            📦 模型库
          </button>
          <button className="link-btn" onClick={() => { setShowMem(v => !v); setShowModels(false); }}>
            🧠 学习 {mem ? `(${mem.stats?.sessions || 0})` : ''}
          </button>
        </div>
      </div>

      {/* ② 模型库 */}
      {showModels && (
        <div className="panel-pop">
          <div className="pop-head">
            <span>本地模型库</span>
            <button className="link-btn" onClick={() => setShowModels(false)}>收起</button>
          </div>
          <div className="pop-hint">
            全部免费开源模型，下载到本地后离线可用。8G 内存推荐 qwen3:4b / qwen2.5-coder:7b。
          </div>
          <div className="model-list">
            {recs.map(m => {
              const lightName = m.light || m.name;
              const lightHas = installed.includes(lightName) ||
                installed.some(x => x.split(':')[0] === lightName.split(':')[0]);
              const fullHas = installed.includes(m.name);
              const lightIsFull = lightName === m.name;
              return (
                <div className="model-row" key={m.name}>
                  <div className="model-main">
                    <div className="model-row-name">
                      {m.name}
                      {fullHas && <span className="tag-ok">已安装</span>}
                      {!fullHas && lightHas && lightIsFull && <span className="tag-ok">已安装</span>}
                      {!fullHas && !lightIsFull && (
                        <span className="tag-light">⚡ 残血版 {lightName.split(':')[1]} 已装/可装</span>
                      )}
                    </div>
                    <div className="model-row-meta">{m.size} · 需 {m.mem} 内存 · {m.lang}</div>
                    <div className="model-row-use">{m.use}</div>
                  </div>
                  {!fullHas && (
                    <div className="model-actions">
                      {!lightIsFull && (
                        <button className="btn-mini btn-accent" disabled={pulling === lightName}
                          onClick={() => pull(lightName)} title={`下载轻量残血版 ${lightName}`}>
                          {pulling === lightName ? '下载中…' : '⚡ 残血版'}
                        </button>
                      )}
                      <button className="btn-mini" disabled={pulling === m.name}
                        onClick={() => pull(m.name)}>
                        {pulling === m.name ? '下载中…' : '完整版'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ③ 自动学习 */}
      {showMem && mem && (
        <div className="panel-pop">
          <div className="pop-head">
            <span>🧠 自动学习</span>
            <button className="link-btn" onClick={() => setShowMem(false)}>收起</button>
          </div>
          <div className="pop-hint">
            软件会分析你的项目风格、积累踩过的坑、记住术语 —— 全部存在项目的
            <code>.devai/memory.json</code> 里，可随项目提交到 Git 共享。
          </div>

          <div className="mem-stats">
            <div className="mem-stat"><b>{mem.stats?.sessions || 0}</b><span>会话</span></div>
            <div className="mem-stat"><b>{mem.stats?.fixes || 0}</b><span>修复</span></div>
            <div className="mem-stat"><b>{mem.stats?.issuesFound || 0}</b><span>发现问题</span></div>
            <div className="mem-stat"><b>{mem.entries?.length || 0}</b><span>记忆条</span></div>
          </div>

          {mem.profile?.languages && Object.keys(mem.profile.languages).length > 0 && (
            <div className="mem-sec">
              <div className="mem-sec-title">项目画像</div>
              <div className="mem-kv">
                <span>语言</span>
                {Object.entries(mem.profile.languages).slice(0, 5).map(([k, v]) => (
                  <span className="mem-chip" key={k}>{k} {v as number}</span>
                ))}
              </div>
              {mem.profile.frameworks?.length > 0 && (
                <div className="mem-kv">
                  <span>技术栈</span>
                  {mem.profile.frameworks.map((x: string) => (
                    <span className="mem-chip" key={x}>{x}</span>
                  ))}
                </div>
              )}
              <div className="mem-kv">
                <span>风格</span>
                {mem.profile.indent && <span className="mem-chip">缩进 {mem.profile.indent}</span>}
                {mem.profile.quotes && <span className="mem-chip">引号 {mem.profile.quotes === 'single' ? '单' : '双'}</span>}
                {mem.profile.semicolons !== undefined && <span className="mem-chip">{mem.profile.semicolons ? '带分号' : '无分号'}</span>}
                {mem.profile.commentLang && <span className="mem-chip">注释 {mem.profile.commentLang}</span>}
              </div>
            </div>
          )}

          {mem.entries?.length > 0 && (
            <div className="mem-sec">
              <div className="mem-sec-title">积累的经验（{mem.entries.length}）</div>
              <div className="mem-entries">
                {mem.entries.slice(-12).reverse().map((e: any) => (
                  <div className="mem-entry" key={e.id}>
                    <span className={`mem-kind ${e.kind}`}>
                      {e.kind === 'issue' ? '问题' : e.kind === 'fix' ? '修复' :
                        e.kind === 'term' ? '术语' : e.kind === 'preference' ? '偏好' : '笔记'}
                    </span>
                    <span className="mem-text">{e.content}</span>
                    {e.hits > 1 && <span className="mem-hits">×{e.hits}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <button className="btn-ghost mem-clear" onClick={async () => {
            if (confirm('清空所有学习到的知识？')) {
              await window.api.memory.clear();
              loadMem();
              onToast('已清空学习数据');
            }
          }}>清空学习数据</button>
        </div>
      )}
    </>
  );
}
