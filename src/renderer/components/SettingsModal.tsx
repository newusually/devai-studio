/* ============================================================================
 * renderer/components/SettingsModal.tsx —— 设置（WorkBuddy 风格：左侧导航 + 右侧内容）
 * ----------------------------------------------------------------------------
 * 通用 / 模型 / 外观 三个分区；模型区承载所有免费来源的探测与配置。
 * ========================================================================== */
import React, { useEffect, useState } from 'react';
import ThemePicker from './ThemePicker';

interface Props {
  slots: any[];
  current: any;
  onClose: () => void;
  onSaved: () => void;
  fontScale?: number;
  onFontScale?: (s: number) => void;
  /** 深度思考（Qwen3 thinking）开关 */
  thinking?: boolean;
  onThinkingChange?: (on: boolean) => void;
}

export default function SettingsModal({ slots, current, onClose, onSaved, fontScale = 1, onFontScale, thinking = false, onThinkingChange }: Props) {
  const [tab, setTab] = useState<string>('model');
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
      <div className="modal settings-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-head">
          <h2>设置</h2>
          <button className="modal-x" onClick={onClose}>✕</button>
        </div>

        <div className="settings-body">
          {/* 左侧导航 */}
          <nav className="settings-nav">
            <div className="snav-group">设置</div>
            <button className={`snav ${tab === 'general' ? 'on' : ''}`} onClick={() => setTab('general')}>通用</button>
            <button className={`snav ${tab === 'model' ? 'on' : ''}`} onClick={() => setTab('model')}>模型</button>
            <button className={`snav ${tab === 'appearance' ? 'on' : ''}`} onClick={() => setTab('appearance')}>外观</button>
          </nav>

          {/* 右侧内容 */}
          <div className="settings-content">
            {tab === 'general' && (
              <div className="scontent">
                <div className="card">
                  <div className="card-title">字体大小</div>
                  <div className="card-desc">调整对话与界面的显示字号。</div>
                  <input
                    type="range" min={0.8} max={1.6} step={0.1}
                    value={fontScale}
                    onChange={e => onFontScale?.(parseFloat(e.target.value))}
                    style={{ width: '100%' }}
                  />
                  <div className="srow">
                    <span>小</span><span>默认</span><span>大</span>
                  </div>
                </div>

                <div className="card">
                  <div className="card-title">语言</div>
                  <div className="card-desc">界面语言（当前固定为中文）。</div>
                  <div className="detail-val"><code>简体中文（zh-CN）</code></div>
                </div>

                <div className="card">
                  <div className="card-title">本地推理引擎</div>
                  <div className="card-desc">
                    使用本地 Ollama 时，DevAI Studio 会在启动时自动拉起 Ollama 服务端（若未运行），
                    模型目录为 <code>F:\ollama-models</code>。无需手动启动。
                  </div>
                </div>
              </div>
            )}

            {tab === 'model' && (
              <div className="scontent">
                {/* ★深度思考开关：默认关（开了解析慢但看得见推理过程） */}
                <div className="detail-row think-toggle-row">
                  <label>深度思考</label>
                  <div className="detail-val">
                    <label className="switch">
                      <input
                        type="checkbox"
                        checked={thinking}
                        onChange={async (e) => {
                          const on = e.target.checked;
                          onThinkingChange?.(on);
                          try { await window.api.model.setThinking(on); } catch { }
                        }}
                      />
                      <span className="switch-slider" />
                    </label>
                    <span className="think-toggle-desc">
                      {thinking ? '已开启：显示推理过程，回答明显变慢' : '已关闭（推荐）：直接作答，速度最快'}
                    </span>
                  </div>
                </div>

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
            )}

            {tab === 'appearance' && (
              <div className="scontent">
                <ThemePicker />
              </div>
            )}
          </div>
        </div>

        <div className="modal-foot">
          {tab === 'model' && (
            <button className="btn-ghost" onClick={probeAll} disabled={probing}>
              {probing ? '检测中…' : '重新检测所有来源'}
            </button>
          )}
          <div className="spacer" />
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" onClick={save}>保存并使用</button>
        </div>
      </div>
    </div>
  );
}
