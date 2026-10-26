/* ============================================================================
 * renderer/App.tsx —— 主界面
 * ----------------------------------------------------------------------------
 * 布局（与 WorkBuddy 风格一致的三栏）：
 *   左：会话列表 + 工作区
 *   中：对话流 + 输入框
 *   右：诊断面板 + 文件树 + Git
 * ========================================================================== */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import SessionList from './components/SessionList';
import ChatPane from './components/ChatPane';
import SidePanel from './components/SidePanel';
import SettingsModal from './components/SettingsModal';
import AgentBar from './components/AgentBar';
import StudioPanel, { StudioTab } from './components/StudioPanel';
import ThemePicker from './components/ThemePicker';
import { StreamEvent } from '../shared/types';

export interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  provider?: string;
  ts: number;
  streaming?: boolean;
  /** 思考过程（Qwen3 thinking，可折叠展示） */
  thinking?: string;
  /** 实时状态行（如"AI 正在生成回答…"） */
  status?: string;
  toolCalls?: Array<{ name: string; args: any; ok?: boolean; text?: string; callId?: string; ts?: number; durationMs?: number }>;
  diagnostics?: any[];
  patch?: any;
  /** ★本轮总耗时（ms，end 事件回填） */
  totalMs?: number;
}

/* ★本地能力（WorkBuddy “专家·技能·连接器” 的本地版）
 * 云端专属的 connector / 真·专家市场无法在本地复刻，这里列出本应用自带的能力，
 * 点击即把对应任务发到对话。 */
const LOCAL_SKILLS: Array<{ icon: string; name: string; prompt: string }> = [
  { icon: '🔍', name: '检查代码', prompt: '请扫描当前工作区，找出语法错误、未使用变量、缺失导入等问题并给出修复建议。' },
  { icon: '📖', name: '解释代码', prompt: '请解释当前工作区里主要的代码结构与关键逻辑。' },
  { icon: '🛠️', name: '修复并应用', prompt: '请检查工作区并给出可应用的修复提案（用 diff 展示，我确认后再写入）。' },
  { icon: '🎬', name: '生成短视频', prompt: '帮我写一个短视频脚本并生成视频。' },
  { icon: '📊', name: '生成 Excel', prompt: '请帮我生成一份 Excel 表格。' },
  { icon: '📄', name: '生成文档', prompt: '请帮我生成一份 Word 文档。' },
];

export default function App() {
  const [info, setInfo] = useState<any>(null);
  /* 深度思考开关（与主进程 settings.thinking 同步，默认关） */
  const [thinking, setThinking] = useState<boolean>(false);
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [diagnostics, setDiagnostics] = useState<any[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [rightTab, setRightTab] = useState<'diag' | 'files' | 'git' | 'studio' | 'code'>('diag');
  const [codeView, setCodeView] = useState<any>(null); // ★右侧代码/diff 查看器数据
  const [toast, setToast] = useState<string>('');
  const [localModels, setLocalModels] = useState<any[]>([]);
  const [recModels, setRecModels] = useState<any[]>([]); // 推荐清单（含 light 残血版）
  const [fontScale, setFontScale] = useState<number>(1);
  const [rightCollapsed, setRightCollapsed] = useState(false);
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [ollama, setOllama] = useState<any>(null);

  const curStreamId = useRef<string>('');

  /* ---------------- 初始化 ---------------- */
  useEffect(() => {
    (async () => {
      // ★初始化界面风格（零重载）
      const { initTheme } = await import('./lib/theme');
      initTheme();
      const i = await window.api.appInfo();
      setInfo(i);
      setThinking(i.thinking === true);
      const list = await window.api.session.list();
      setSessions(list);
      if (list.length) {
        setCurrentId(list[0].id);
      } else {
        const s = await window.api.session.create('新会话');
        setSessions([s]);
        setCurrentId(s.id);
      }
      // ★加载本地已装模型，供对话内模型选择器使用（WorkBuddy 风格）
      //   （模型列表在下面有独立轮询 effect，这里先做一次快速尝试）
      try {
        const res = await window.api.model.list('ollama');
        const row = Array.isArray(res) ? res.find((r: any) => r.kind === 'ollama') : null;
        setLocalModels(row?.models || []);
      } catch (e) { }
      // ★查询 Ollama 服务状态，供侧边栏显示
      try {
        setOllama(await window.api.ollama.status());
      } catch (e) { }
      // ★启动即扫当前工作区（2026-10-26 修）：右栏"问题"反映真实代码状态，
      //   而不是回放历史会话里已过期的旧诊断（会让人以为"什么都没改"）。
      try {
        const r = await window.api.analyze.workspace();
        setDiagnostics(r.diagnostics || []);
      } catch (e) { }
    })();
  }, []);

  /* ---------------- 本地模型列表轮询（2026-10-26 修：模型下拉选不了） ----------------
   *   根因：ollama 已改为【异步启动】（窗口先弹、不被 ollama 阻塞），
   *   所以启动瞬间 11434 端口往往还没就绪 → 一次性拉取必然得到空列表 →
   *   对话底部的模型下拉显示"（无可用模型）"，用户一个模型都选不了。
   *   改为持续轮询：拿到模型后每 10s 刷新一次（用户新下载的模型会自动出现）。 */
  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!alive) return;
      try {
        const res = await window.api.model.list('ollama');
        if (!alive) return;
        const row = Array.isArray(res) ? res.find((r: any) => r.kind === 'ollama') : null;
        const list = row?.models || [];
        setLocalModels((prev: any[]) => {
          // 避免无意义重渲染：只有内容真变了才更新
          const a = prev.map((m) => m.id).join(',');
          const b = list.map((m) => m.id).join(',');
          return a === b ? prev : list;
        });
      } catch (e) { }
      // 加载推荐清单（含残血版），供对话下拉显示"未下载但可一键下载"的模型
      try {
        const r = await window.api.model.recommend();
        if (alive) setRecModels(r?.models || []);
      } catch (e) { }
    };
    void load();
    const iv = setInterval(load, 10000);
    return () => { alive = false; clearInterval(iv); };
  }, []);

  /* ---------------- 切换当前模型（对话内选择器） ----------------
   * 支持未安装：下拉里选到"未下载"的推荐模型时，先拉取（后台）再切换。 */
  const changeModel = useCallback(async (model: string, isUninstalled?: boolean) => {
    if (isUninstalled) {
      setToast(`正在下载 ${model}（后台进行）…`);
      const r = await window.api.model.pull(model);
      if (!r?.ok) { setToast(`✗ ${model} 下载失败：${r?.error || ''}`); return; }
      setToast(`✓ ${model} 已下载`);
    }
    const d = await window.api.model.set('ollama', model);
    if (d) {
      setInfo((prev: any) => prev ? { ...prev, provider: d } : prev);
      setToast(`已切换到模型 ${model}`);
    }
  }, []);

  /* ---------------- 载入会话 ---------------- */
  const loadSession = useCallback(async (id: string) => {
    const d = await window.api.session.get(id);
    if (!d) return;
    setCurrentId(id);
    setMessages((d.messages || []).map((m: any, i: number) => ({
      id: `m${i}`,
      role: m.role,
      content: m.content,
      model: m.model,
      provider: m.provider,
      ts: m.ts,
    })));
    /* ★2026-10-26 修：不再回放历史会话里已过期的诊断。
     *   那些诊断是扫描"当时"的代码得到的，代码改好后就该消失；
     *   回放旧数据会让人误以为修改没生效。改为实时重扫当前工作区。 */
    try {
      const r = await window.api.analyze.workspace();
      setDiagnostics(r.diagnostics || []);
    } catch (e) {
      setDiagnostics([]);
    }
  }, []);

  useEffect(() => {
    if (currentId) loadSession(currentId);
  }, [currentId, loadSession]);

  /* ---------------- 订阅流式事件 ---------------- */
  useEffect(() => {
    return window.api.chat.onStream((e: StreamEvent) => {
      if (e.sessionId !== curStreamId.current) return;
      setMessages(prev => {
        const last = prev[prev.length - 1];
        switch (e.type) {
          case 'start':
            return prev;
          case 'status': {
            /* 实时状态：挂到正在流式的气泡上（没有就先建一个，绝不空白） */
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0) {
              next[idx] = { ...next[idx], status: e.text || '' };
            } else {
              next.push({
                id: `a${Date.now()}`, role: 'assistant', content: '',
                model: e.model, provider: e.provider, ts: Date.now(),
                streaming: true, toolCalls: [], status: e.text || '',
              });
            }
            return next;
          }
          case 'thinking': {
            /* 思考增量：实时累积到气泡的 thinking 字段 */
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0) {
              next[idx] = { ...next[idx], thinking: (next[idx].thinking || '') + (e.text || '') };
            } else {
              next.push({
                id: `a${Date.now()}`, role: 'assistant', content: '',
                model: e.model, provider: e.provider, ts: Date.now(),
                streaming: true, toolCalls: [], thinking: e.text || '',
              });
            }
            return next;
          }
          case 'token': {
            if (!last || last.role !== 'assistant' || !last.streaming) {
              return [...prev, {
                id: `a${Date.now()}`,
                role: 'assistant',
                content: e.text || '',
                model: e.model,
                provider: e.provider,
                ts: Date.now(),
                streaming: true,
                toolCalls: [],
              }];
            }
            const next = [...prev];
            next[next.length - 1] = { ...last, content: last.content + (e.text || '') };
            return next;
          }
          case 'tool': {
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0) {
              next[idx] = {
                ...next[idx],
                toolCalls: [...(next[idx].toolCalls || []), {
                  name: e.toolCall!.name, args: e.toolCall!.args,
                  callId: (e.toolCall as any)?.callId, ts: e.ts || Date.now(),
                }],
              };
            }
            return next;
          }
          case 'tool_result': {
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0 && e.toolResult) {
              const tcs = [...(next[idx].toolCalls || [])];
              const cid = (e.toolCall as any)?.callId;
              /* ★优先按 callId 精确匹配；旧事件（无 callId）退回按名字+未完成匹配 */
              let ti = cid
                ? tcs.findIndex(t => (t as any).callId === cid)
                : tcs.findIndex(t => t.name === e.toolCall!.name && t.ok === undefined);
              if (ti >= 0) tcs[ti] = {
                ...tcs[ti], ok: e.toolResult.ok, text: e.toolResult.text,
                durationMs: e.durationMs,
              };
              next[idx] = { ...next[idx], toolCalls: tcs };
            }
            return next;
          }
          case 'diagnostics': {
            setDiagnostics(e.diagnostics || []);
            return prev;
          }
          case 'patch': {
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0) next[idx] = { ...next[idx], patch: e.patch };
            return next;
          }
          case 'end':
          case 'error': {
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0) {
              next[idx] = {
                ...next[idx], streaming: false,
                totalMs: e.usage?.durationMs ?? next[idx].totalMs,
              };
              if (e.error) next[idx] = { ...next[idx], content: next[idx].content + `\n\n⚠️ ${e.error}` };
            }
            setStreaming(false);
            return next;
          }
          default:
            return prev;
        }
      });
    });
  }, []);

  /* ---------------- 发送消息 ---------------- */
  const send = useCallback(async (text: string) => {
    if (!text.trim() || streaming || !currentId) return;
    const userMsg: Msg = {
      id: `u${Date.now()}`,
      role: 'user',
      content: text,
      ts: Date.now(),
    };
    const placeholderId = `a${Date.now()}`;
    // ★发送即插入占位气泡并显示"正在思考"，给用户明确的处理过程提示（对齐 WorkBuddy）
    setMessages(p => [...p, userMsg, {
      id: placeholderId,
      role: 'assistant',
      content: '',
      model: info?.provider?.model,
      provider: 'ollama',
      ts: Date.now(),
      streaming: true,
      toolCalls: [],
    }]);
    setStreaming(true);
    curStreamId.current = currentId;

    try {
      await window.api.chat.send(currentId, text);
      // 刷新会话列表（标题/预览已更新）
      const list = await window.api.session.list();
      setSessions(list);
    } catch (e: any) {
      // chat.send 异常（极少见）→ 在占位气泡里兜底显示错误，避免卡在"正在思考"
      setMessages(p => {
        const last = p[p.length - 1];
        if (last && last.id === placeholderId && last.streaming) {
          return [...p.slice(0, -1), { ...last, content: `⚠️ 对话请求失败：${e?.message || e}`, streaming: false }];
        }
        return p;
      });
    } finally {
      setStreaming(false);
    }
  }, [currentId, streaming, info]);

  /* ---------------- 菜单动作 ---------------- */
  useEffect(() => {
    return window.api.onMenu(async (action) => {
      switch (action) {
        case 'new-session': {
          const s = await window.api.session.create('新会话');
          setSessions(await window.api.session.list());
          setCurrentId(s.id);
          break;
        }
        case 'open-settings':
          setShowSettings(true);
          break;
        case 'focus-input':
          document.getElementById('chat-input')?.focus();
          break;
        case 'scan-workspace': {
          const r = await window.api.analyze.workspace();
          setDiagnostics(r.diagnostics || []);
          setRightTab('diag');
          setToast(`扫描完成：发现 ${r.count} 个问题`);
          break;
        }
        case 'workspace-changed': {
          const i = await window.api.appInfo();
          setInfo(i);
          setToast(`工作区已切换到 ${i.workspace}`);
          break;
        }
        case 'git-status': {
          setRightTab('git');
          break;
        }
        case 'probe-providers': {
          setShowSettings(true);
          break;
        }
      }
    });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  if (!info) {
    return <div className="boot">正在启动 DevAI Studio…</div>;
  }

  return (
    <div className={`app ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''}`}>
      {/* 左栏 */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">D</div>
          <div className="brand-text">
            <div className="brand-name">DevAI Studio</div>
            <div className="brand-ver">v{info.version}</div>
          </div>
          <button className="sb-collapse" onClick={() => setLeftCollapsed(true)} title="收起左侧边栏">‹</button>
        </div>

        {/* ★品牌区以下全部可滚动：内容超高时能下拉，不再被裁掉 */}
        <div className="sb-scroll">
        <button className="btn-primary" onClick={async () => {
          const s = await window.api.session.create('新会话');
          setSessions(await window.api.session.list());
          setCurrentId(s.id);
        }}>
          ＋ 新建任务
        </button>

        <div className="nav-group">助理</div>
        <AgentBar
          currentModel={info.provider.model}
          onRoleChange={(id) => {}}
          onToast={setToast}
        />

        <div className="nav-group">
          本地能力
          <span className="nav-note">（专家·技能·连接器的本地版）</span>
        </div>
        <div className="skills-mini">
          {LOCAL_SKILLS.map(sk => (
            <button
              key={sk.prompt}
              className="skill-chip"
              title={sk.prompt}
              disabled={streaming}
              onClick={() => send(sk.prompt)}
            >{sk.icon} {sk.name}</button>
          ))}
        </div>

        <div className="model-box">
          <div className="ws-label">当前模型</div>
          <div className="model-name">{info.provider.name}</div>
          <div className="model-id">{info.provider.model}</div>
          <div className="model-quota">{info.provider.freeQuota}</div>
          <button className="link-btn" onClick={() => setShowSettings(true)}>切换 / 配置</button>
        </div>

        <div className="ollama-box">
          <div className="ws-label">Ollama 服务</div>
          <div className="ollama-status">
            <span className={`dot ${ollama?.up ? 'ok' : 'no'}`}></span>
            <span>{ollama?.up ? '运行中' : '未运行'}</span>
          </div>
          <div className="ollama-actions">
            {ollama?.up ? (
              <button className="link-btn" onClick={async () => {
                setToast('正在重启 Ollama…');
                await window.api.ollama.start(true);
                setOllama(await window.api.ollama.status());
                setToast('已重启 Ollama');
              }}>重启</button>
            ) : (
              <button className="link-btn" onClick={async () => {
                setToast('正在启动 Ollama…');
                const r = await window.api.ollama.start(false);
                setOllama(await window.api.ollama.status());
                setToast(r.message);
              }}>启动 Ollama</button>
            )}
            <button className="link-btn" onClick={async () => setOllama(await window.api.ollama.status())}>刷新</button>
          </div>
        </div>

        <div className="ws-box" title={info.workspace}>
          <div className="ws-label">工作区</div>
          <div className="ws-path">{info.workspace}</div>
          <button className="link-btn" onClick={async () => {
            await window.api.dialog.openDir();
            const i = await window.api.appInfo();
            setInfo(i);
          }}>更换目录</button>
        </div>

        <ThemePicker compact />

        <div className="zoom-box">
          <span className="ws-label">字号</span>
          <div className="zoom-ctrl">
            <button onClick={() => setFontScale(s => Math.max(0.8, +(s - 0.1).toFixed(2)))} title="缩小">A−</button>
            <span className="zoom-val">{Math.round(fontScale * 100)}%</span>
            <button onClick={() => setFontScale(s => Math.min(1.6, +(s + 0.1).toFixed(2)))} title="放大">A＋</button>
          </div>
        </div>
        </div>

        {/* 会话列表：保持原有设计（自身内部滚动，占满底部剩余空间） */}
        <SessionList
          sessions={sessions}
          currentId={currentId}
          onSelect={setCurrentId}
          onDelete={async (id) => {
            await window.api.session.remove(id);
            const list = await window.api.session.list();
            setSessions(list);
            if (id === currentId) setCurrentId(list[0]?.id || '');
          }}
          onRename={async (id, title) => {
            await window.api.session.rename(id, title);
            setSessions(await window.api.session.list());
          }}
        />
      </aside>

      {/* 中栏 */}
      <main className="main">
        <ChatPane
          messages={messages}
          streaming={streaming}
          sessionId={currentId}
          currentModel={info?.provider?.model || ''}
          models={localModels}
          recommended={recModels}
          onModelChange={changeModel}
          fontScale={fontScale}
          onSend={send}
          onAbort={async () => {
            await window.api.chat.abort(currentId);
            setStreaming(false);
          }}
          onApplyPatch={async (patch) => {
            const r = await window.api.patch.apply(currentId, patch);
            setToast(r.ok ? '修改已应用' : '应用失败');
            return r;
          }}
          onRejectPatch={async () => {
            await window.api.patch.reject(currentId, '');
            setToast('已回滚修改');
          }}
          onOpenFile={(change) => {
            /* ★点改动文件 → 右侧面板打开 diff 代码查看器 */
            setCodeView(change);
            setRightTab('code');
            setRightCollapsed(false);
          }}
        />
      </main>

      {/* 右栏 */}
      <aside className={`sidepanel ${rightCollapsed ? 'collapsed' : ''}`}>
        <div className="sp-head">
        <div className="tabs">
          <button className={rightTab === 'diag' ? 'tab on' : 'tab'} onClick={() => setRightTab('diag')}>
            问题 {diagnostics.filter((d: any) => d.severity === 'error' || d.severity === 'warning').length > 0 && <span className="badge">{diagnostics.filter((d: any) => d.severity === 'error' || d.severity === 'warning').length}</span>}
          </button>
          <button className={rightTab === 'code' ? 'tab on' : 'tab'} onClick={() => codeView && setRightTab('code')}>
            代码 {codeView && <span className="badge">•</span>}
          </button>
          <button className={rightTab === 'files' ? 'tab on' : 'tab'} onClick={() => setRightTab('files')}>文件</button>
          <button className={rightTab === 'git' ? 'tab on' : 'tab'} onClick={() => setRightTab('git')}>Git</button>
          <button className={rightTab === 'studio' ? 'tab on' : 'tab'} onClick={() => setRightTab('studio')}>工作室</button>
        </div>
        <button className="sp-collapse" onClick={() => setRightCollapsed(true)} title="收起右侧面板">‹</button>
        </div>
        <SidePanel
          tab={rightTab}
          diagnostics={diagnostics}
          workspace={info.workspace}
          codeView={codeView}
          onOpenSettings={() => setShowSettings(true)}
          onToast={setToast}
          onOpenFolder={(p) => { window.api.dialog.showItem(p); }}
        />
      </aside>

      {rightCollapsed && (
        <button className="sp-expand" onClick={() => setRightCollapsed(false)} title="展开右侧面板 / 工具">› 工具面板</button>
      )}

      {leftCollapsed && (
        <button className="sb-expand" onClick={() => setLeftCollapsed(false)} title="展开左侧边栏 / 工作区">‹ 侧边栏</button>
      )}

      {showSettings && (
        <SettingsModal
          slots={info.slots}
          current={info.provider}
          fontScale={fontScale}
          onFontScale={setFontScale}
          thinking={thinking}
          onThinkingChange={setThinking}
          onClose={() => setShowSettings(false)}
          onSaved={async () => {
            const i = await window.api.appInfo();
            setInfo(i);
            setShowSettings(false);
            setToast('设置已保存');
          }}
        />
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
}
