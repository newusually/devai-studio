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
import VideoPanel from './components/VideoPanel';
import { StreamEvent } from '../shared/types';

export interface Msg {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model?: string;
  provider?: string;
  ts: number;
  streaming?: boolean;
  toolCalls?: Array<{ name: string; args: any; ok?: boolean; text?: string }>;
  diagnostics?: any[];
  patch?: any;
}

export default function App() {
  const [info, setInfo] = useState<any>(null);
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentId, setCurrentId] = useState<string>('');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [diagnostics, setDiagnostics] = useState<any[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [rightTab, setRightTab] = useState<'diag' | 'files' | 'git' | 'video'>('diag');
  const [toast, setToast] = useState<string>('');

  const curStreamId = useRef<string>('');

  /* ---------------- 初始化 ---------------- */
  useEffect(() => {
    (async () => {
      const i = await window.api.appInfo();
      setInfo(i);
      const list = await window.api.session.list();
      setSessions(list);
      if (list.length) {
        setCurrentId(list[0].id);
      } else {
        const s = await window.api.session.create('新会话');
        setSessions([s]);
        setCurrentId(s.id);
      }
    })();
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
    setDiagnostics(d.diagnostics || []);
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
                toolCalls: [...(next[idx].toolCalls || []), { name: e.toolCall!.name, args: e.toolCall!.args }],
              };
            }
            return next;
          }
          case 'tool_result': {
            const next = [...prev];
            const idx = next.findIndex(m => m.streaming);
            if (idx >= 0 && e.toolResult) {
              const tcs = [...(next[idx].toolCalls || [])];
              const ti = tcs.findIndex(t => t.name === e.toolCall!.name && t.ok === undefined);
              if (ti >= 0) tcs[ti] = { ...tcs[ti], ok: e.toolResult.ok, text: e.toolResult.text };
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
              next[idx] = { ...next[idx], streaming: false };
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
    setMessages(p => [...p, userMsg]);
    setStreaming(true);
    curStreamId.current = currentId;

    const res = await window.api.chat.send(currentId, text);
    if (res?.error && !res?.ok) {
      setMessages(p => [...p, {
        id: `e${Date.now()}`,
        role: 'assistant',
        content: `请求失败：${res.error}`,
        ts: Date.now(),
      }]);
      setStreaming(false);
    } else {
      // 刷新会话列表（标题/预览已更新）
      const list = await window.api.session.list();
      setSessions(list);
    }
  }, [currentId, streaming]);

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
    <div className="app">
      {/* 左栏 */}
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-logo">D</div>
          <div className="brand-text">
            <div className="brand-name">DevAI Studio</div>
            <div className="brand-ver">v{info.version}</div>
          </div>
        </div>

        <button className="btn-primary" onClick={async () => {
          const s = await window.api.session.create('新会话');
          setSessions(await window.api.session.list());
          setCurrentId(s.id);
        }}>
          ＋ 新建会话
        </button>

        <div className="ws-box" title={info.workspace}>
          <div className="ws-label">工作区</div>
          <div className="ws-path">{info.workspace}</div>
          <button className="link-btn" onClick={async () => {
            await window.api.dialog.openDir();
            const i = await window.api.appInfo();
            setInfo(i);
          }}>更换目录</button>
        </div>

        <div className="model-box">
          <div className="ws-label">当前模型</div>
          <div className="model-name">{info.provider.name}</div>
          <div className="model-id">{info.provider.model}</div>
          <div className="model-quota">{info.provider.freeQuota}</div>
          <button className="link-btn" onClick={() => setShowSettings(true)}>切换 / 配置</button>
        </div>

        <AgentBar
          currentModel={info.provider.model}
          onRoleChange={(id) => {}}
          onToast={setToast}
        />

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
        />
      </main>

      {/* 右栏 */}
      <aside className="sidepanel">
        <div className="tabs">
          <button className={rightTab === 'diag' ? 'tab on' : 'tab'} onClick={() => setRightTab('diag')}>
            问题 {diagnostics.length > 0 && <span className="badge">{diagnostics.length}</span>}
          </button>
          <button className={rightTab === 'files' ? 'tab on' : 'tab'} onClick={() => setRightTab('files')}>文件</button>
          <button className={rightTab === 'git' ? 'tab on' : 'tab'} onClick={() => setRightTab('git')}>Git</button>
          <button className={rightTab === 'video' ? 'tab on' : 'tab'} onClick={() => setRightTab('video')}>短视频</button>
        </div>
        <SidePanel
          tab={rightTab}
          diagnostics={diagnostics}
          workspace={info.workspace}
          onOpenSettings={() => setShowSettings(true)}
          onToast={setToast}
        />
      </aside>

      {showSettings && (
        <SettingsModal
          slots={info.slots}
          current={info.provider}
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
