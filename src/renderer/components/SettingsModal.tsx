/* ============================================================================
 * renderer/components/SettingsModal.tsx —— 模型与来源设置
 * ----------------------------------------------------------------------------
 * 展示所有免费来源的可用性，一键探测；填入 API Key 后立即生效。
 * ========================================================================== */
import React, { useEffect, useState } from 'react';

interface Props {
  slots: any[];
  current: any;
  onClose: () => void;
  onSaved: () => void;
}

export default function SettingsModal({ slots, current, onClose, onSaved }: Props) {
  const [kind, setKind] = useState<string>(current?.kind || 'ollama');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<any[]>([]);
  const [probes, setProbes] = useState<Record<string, any>>({});
  const [probing, setProbing] = useState(false);
  const [loadingModels, setLoadingModels] = useState(false);
  const [msg, setMsg] = useState('');

  const slot = slots.find(s => s.kind === kind);

  const probeAll = async () => {
    setProbing(true);
    setMsg('');
    try {
      const r = await window.api.model.probe();
      const map: Record<string, any> = {};
      for (const p of r) map[p.kind] = p;
      setProbes(map);
      const okList = r.filter(p => p.ok).map(p => p.kind);
      setMsg(okList.length ? `可用：${okList.join('、')}` : '没有检测到可用来源');
    } catch (e: any) {
      setMsg('探测失败：' + (e?.message || e));
    }
    setProbing(false);
  };

  const loadModels = async (k: string) => {
    setLoadingModels(true);
    try {
      const r = await window.api.model.list(k);
      const found = r.find(x => x.kind === k);
      setModels(found?.models || []);
      if (!model && found?.models?.length) setModel(found.models[0].id);
    } catch (e) {
      setModels([]);
    }
    setLoadingModels(false);
  };

  useEffect(() => {
    probeAll();
    loadModels(kind);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadModels(kind);
    setModel('');
    setApiKey('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const save = async () => {
    try {
      if (apiKey.trim()) await window.api.model.setKey(kind, apiKey.trim());
      await window.api.model.set(kind, model || undefined);
      onSaved();
    } catch (e: any) {
      setMsg('保存失败：' + (e?.message || e));
    }
  };

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>模型与来源</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <div className="settings-hint">
            全部免费方案，无需付费：
            <b>本地 Ollama</b> 完全离线无限量；
            <b>OpenRouter</b> / <b>Gemini</b> / <b>Groq</b> 都有免费层（需免费注册拿 Key）。
          </div>

          <div className="slots">
            {slots.map(s => {
              const p = probes[s.kind];
              return (
                <button
                  key={s.kind}
                  className={`slot ${kind === s.kind ? 'on' : ''}`}
                  onClick={() => setKind(s.kind)}
                >
                  <div className="slot-top">
                    <span className="slot-name">{s.name}</span>
                    {p && (
                      <span className={`dot ${p.ok ? 'ok' : 'no'}`} title={p.message} />
                    )}
                  </div>
                  <div className="slot-quota">{s.freeQuota}</div>
                  {p && <div className="slot-msg">{p.message}</div>}
                </button>
              );
            })}
          </div>

          {slot && (
            <div className="slot-detail">
              <div className="detail-row">
                <label>说明</label>
                <div className="detail-val">{slot.hint}</div>
              </div>

              {slot.needsKey && (
                <div className="detail-row">
                  <label>API Key</label>
                  <div className="detail-val">
                    <input
                      type="password"
                      value={apiKey}
                      onChange={e => setApiKey(e.target.value)}
                      placeholder={slot.hasKey ? '已配置（留空则不修改）' : '粘贴你的免费 API Key'}
                    />
                    <a className="link-btn" href={slot.docsUrl} target="_blank" rel="noreferrer">
                      去获取 ↗
                    </a>
                  </div>
                </div>
              )}

              <div className="detail-row">
                <label>模型</label>
                <div className="detail-val">
                  {loadingModels ? (
                    <span className="muted">加载中…</span>
                  ) : models.length > 0 ? (
                    <select value={model} onChange={e => setModel(e.target.value)}>
                      {models.map(m => (
                        <option key={m.id} value={m.id}>
                          {m.name}{m.size ? ` (${m.size})` : ''}{m.free ? ' · 免费' : ''}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <div className="model-manual">
                      <input
                        value={model}
                        onChange={e => setModel(e.target.value)}
                        placeholder={slot.defaultModel}
                      />
                      <span className="muted">未检测到可用模型，可手动填写模型名</span>
                    </div>
                  )}
                </div>
              </div>

              <div className="detail-row">
                <label>端点</label>
                <div className="detail-val">
                  <code>{slot.override?.baseUrl || slot.baseUrl}</code>
                </div>
              </div>
            </div>
          )}

          {msg && <div className="settings-msg">{msg}</div>}
        </div>

        <div className="modal-foot">
          <button className="btn-ghost" onClick={probeAll} disabled={probing}>
            {probing ? '检测中…' : '重新检测所有来源'}
          </button>
          <div className="spacer" />
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={save}>保存并使用</button>
        </div>
      </div>
    </div>
  );
}
