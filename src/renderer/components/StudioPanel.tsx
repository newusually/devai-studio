/* ============================================================================
 * renderer/components/StudioPanel.tsx —— 工作室面板
 * ----------------------------------------------------------------------------
 * 五个标签页：
 *   引擎  —— 多引擎选择 + 硬件检测 + 按需启动
 *   媒体  —— 上传/格式识别/视频音频图片处理
 *   文档  —— PPT/PDF/DOCX/HTML/MD 生成
 *   表格  —— Excel 生成与解析
 *   批量  —— 批量短视频流水线
 * ========================================================================== */
import React, { useEffect, useRef, useState } from 'react';

export type StudioTab = 'engine' | 'media' | 'doc' | 'excel' | 'batch';

export default function StudioPanel({
  tab, onToast, onOpenFolder
}: {
  tab: StudioTab;
  onToast: (m: string) => void;
  onOpenFolder: (p: string) => void;
}) {
  switch (tab) {
    case 'engine': return <EngineTab onToast={onToast} />;
    case 'media': return <MediaTab onToast={onToast} onOpenFolder={onOpenFolder} />;
    case 'doc': return <DocTab onToast={onToast} onOpenFolder={onOpenFolder} />;
    case 'excel': return <ExcelTab onToast={onToast} onOpenFolder={onOpenFolder} />;
    case 'batch': return <BatchTab onToast={onToast} onOpenFolder={onOpenFolder} />;
  }
}

/* ============================================================================
 * 引擎标签页
 * ========================================================================== */
function EngineTab({ onToast }: { onToast: (m: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [probing, setProbing] = useState(false);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [thread, setThread] = useState(0);
  const [models, setModels] = useState<any[]>([]);
  const [bigModels, setBigModels] = useState<any[]>([]);
  /* ★下载进度：模型名 → {percent, status}（实时进度条渲染） */
  const [pulls, setPulls] = useState<Record<string, { percent: number; status: string }>>({});
  /* ★ffmpeg 一键安装状态 */
  const [ffInst, setFfInst] = useState<{ busy: boolean; percent: number; status: string }>({ busy: false, percent: 0, status: '' });

  const threadHint = thread === 0 ? '全部核心（最快）' : `${thread} 线程（更省 CPU）`;

  const [installed, setInstalled] = useState<string[]>([]);
  const load = async () => {
    const d = await window.api.engine.list();
    setData(d);
    try {
      const r = await window.api.model.list('ollama');
      const f = r.find((x: any) => x.kind === 'ollama');
      setInstalled((f?.models || []).map((m: any) => m.id));
    } catch (e) { }
    const r = await window.api.model.recommend();
    setModels(r?.models || []);
    setBigModels(r?.bigModels || []);
  };
  useEffect(() => {
    load();
    /* ★订阅模型下载进度（主进程 /api/pull 流式解析后推送） */
    const off = (window.api.model as any).onPullProgress?.((p: any) => {
      setPulls((s) => ({ ...s, [p.name]: { percent: p.percent ?? 0, status: p.status || '' } }));
    });
    /* ★订阅 ffmpeg 安装进度 */
    const offFf = (window.api as any).ffmpeg?.onProgress?.((p: any) => {
      setFfInst({ busy: p.phase !== 'done' && p.phase !== 'error', percent: p.percent ?? 0, status: p.status || '' });
    });
    return () => { off?.(); offFf?.(); };
  }, []);

  const setThreads = async (n: number) => {
    setThread(n);
    await window.api.engine.setOption({ numThread: n });
    onToast(n === 0 ? '推理将使用全部核心' : `推理线程数设为 ${n}（CPU 占用显著降低）`);
  };

  const pullModel = async (name: string) => {
    onToast(`开始下载 ${name}，进度见列表`);
    const r = await window.api.model.pull(name);
    setPulls((s) => { const c = { ...s }; delete c[name]; return c; });
    if (r?.ok) { onToast(`✓ ${name} 下载完成`); load(); }
    else onToast(`✗ ${name} 下载失败：${r?.error || ''}`);
  };

  const installFfmpeg = async () => {
    setFfInst({ busy: true, percent: 0, status: '准备下载…' });
    onToast('开始下载安装 ffmpeg（约 100MB）');
    const r = await (window.api as any).ffmpeg.install();
    if (r?.ok) { onToast('✓ ffmpeg 安装完成，媒体功能已就绪'); load(); }
    else onToast(`✗ ffmpeg 安装失败：${r?.error || ''}`);
    setFfInst({ busy: false, percent: r?.ok ? 100 : 0, status: r?.ok ? '安装完成' : '' });
  };

  const probe = async () => {
    setProbing(true);
    onToast('正在探测各引擎…');
    const r = await window.api.engine.probe();
    setProbing(false);
    if (r?.status) {
      setData((d: any) => ({ ...d, status: r.status, hardware: r.hardware }));
      const ok = r.status.filter((s: any) => s.available).map((s: any) => s.kind);
      onToast(ok.length ? `可用：${ok.join('、')}` : '没有可用引擎');
    }
  };

  const pick = async (kind: string) => {
    await window.api.engine.set(kind);
    await load();
    onToast(`已切换到 ${kind}`);
  };

  const startLocal = async () => {
    const r = await window.api.engine.startLocal();
    onToast(r.ok ? `✓ ${r.message}` : `✗ ${r.message}`);
    if (r.ok) setTimeout(probe, 3000);
  };

  const saveKey = async (kind: string) => {
    const k = keys[kind];
    if (!k) return;
    await window.api.engine.setKey(kind, k);
    setKeys({ ...keys, [kind]: '' });
    onToast('API Key 已保存');
    probe();
  };

  if (!data) return <div className="empty"><div className="empty-icon">⏳</div>加载中…</div>;

  const hw = data.hardware || {};

  return (
    <div className="panel-body">
      {/* 硬件信息 */}
      <div className="hw-box">
        <div className="hw-title">🖥 本机硬件检测</div>
        <div className="hw-grid">
          <div><span>显卡</span><b>{hw.gpu || '未检测到'}</b></div>
          <div><span>显存</span><b>{hw.vramGb ? hw.vramGb + ' GB' : '无独显'}</b></div>
          <div><span>内存</span><b>{hw.ramGb ? hw.ramGb + ' GB' : '?'}</b></div>
          <div><span>CPU 线程</span><b>{hw.cpuCores || '?'}</b></div>
          <div><span>ffmpeg</span>
            <b className={data.ffmpeg ? 'ok' : 'no'}>{data.ffmpeg ? '✓ 就绪' : '✗ 缺失'}</b>
          </div>
          <div><span>本地视频模型</span>
            <b className={hw.seedanceLocalOk ? 'ok' : 'no'}>
              {hw.seedanceLocalOk ? `✓ 可用（建议 ${hw.suggestSeedance}）` : '✗ 硬件不足'}
            </b>
          </div>
        </div>
      </div>

      {/* ★ffmpeg 一键安装（缺失时显示） */}
      {!data.ffmpeg && (
        <div className="hw-box" style={{ marginTop: 8 }}>
          <div className="hw-title">🎞 ffmpeg 媒体引擎</div>
          <div className="vp-hint" style={{ marginBottom: 7 }}>
            未检测到 ffmpeg。视频抽帧/转码/合成 MP4 等媒体功能需要它，
            点击下方按钮自动下载官方构建（约 100MB）并部署到应用目录，无需重启。
          </div>
          {ffInst.busy ? (
            <div className="dl-bar" title={ffInst.status}>
              <div className="dl-fill" style={{ width: `${Math.max(4, ffInst.percent)}%` }} />
              <span className="dl-text">{ffInst.status || '处理中…'}</span>
            </div>
          ) : (
            <button className="btn-mini btn-accent" onClick={installFfmpeg}>
              {ffInst.status === '安装完成' ? '✓ 安装完成' : '⬇ 一键下载安装 ffmpeg'}
            </button>
          )}
        </div>
      )}

      <div className="vp-hint" style={{ marginTop: 10 }}>
        ★ <b>按需加载</b>：重型引擎（本地 Seedance / Ollama）只有你点「生成视频」时才会启动，
        平时完全不占显存与内存。硬件不足的引擎会自动降级到本地轻量模式。
      </div>

      {/* 线程数控制（CPU 可控） */}
      <div className="hw-box">
        <div className="hw-title">⚙️ 推理性能</div>
        <div className="hw-grid">
          <div><span>CPU 线程数</span>
            <b>{threadHint}</b>
          </div>
          <div><span>说明</span><b style={{ fontSize: 10.5 }}>线程越少 CPU 越省</b></div>
        </div>
        <div className="kind-row" style={{ marginTop: 7 }}>
          {[0, 1, 2, 4].map(n => (
            <button key={n} className={`kchip ${thread === n ? 'on' : ''}`}
              onClick={() => setThread(n)}>
              {n === 0 ? '全部核心' : `${n} 线程`}
            </button>
          ))}
        </div>
        <div className="vp-hint" style={{ marginTop: 4 }}>
          实测（4 核）：1 线程 15.5s · 2 线程 12.7s · 4 线程 12.1s。
          设 <b>2 线程</b> 可让 CPU 占用减半而速度几乎不变。
        </div>
      </div>

      {/* 引擎列表 */}
      <div className="eng-list">
        {data.engines?.map((e: any) => {
          const st = (data.status || []).find((s: any) => s.kind === e.kind);
          const on = data.current === e.kind;
          return (
            <div className={`eng ${on ? 'on' : ''} ${st && !st.available ? 'off' : ''}`} key={e.kind}>
              <div className="eng-head">
                <label className="eng-radio">
                  <input type="radio" checked={on} onChange={() => pick(e.kind)} />
                  <span className="eng-name">{e.name}</span>
                </label>
                <span className={`eng-free ${e.free ? 'yes' : ''}`}>{e.freeNote}</span>
              </div>

              <div className="eng-desc">{e.desc}</div>

              <div className="eng-meta">
                <span>🏷 {e.features.join(' / ')}</span>
                {e.needsGpu && <span>🎮 需独显 {e.minVram}G+</span>}
                {e.local && <span>📴 离线可用</span>}
                {e.needsKey && <span>🔑 需 API Key</span>}
                {e.heavy && <span>⚡ 按需启动</span>}
              </div>

              {st && (
                <div className={`eng-status ${st.available ? 'ok' : 'no'}`}>
                  {st.available ? '✓' : '✗'} {st.reason}
                  {st.extra && <span className="eng-extra"> · {st.extra}</span>}
                </div>
              )}

              {/* 操作区 */}
              <div className="eng-actions">
                {e.kind === 'seedance-local' && st?.available && (
                  <button className="btn-mini" onClick={startLocal}>启动本地模型</button>
                )}
                {e.kind === 'seedance-api' && (
                  <div className="eng-key">
                    <input
                      type="password"
                      placeholder={st?.hasKey ? '已配置（留空不改）' : '粘贴火山引擎 API Key'}
                      value={keys[e.kind] || ''}
                      onChange={ev => setKeys({ ...keys, [e.kind]: ev.target.value })}
                    />
                    <button className="btn-mini" onClick={() => saveKey(e.kind)}>保存</button>
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <button className="btn-ghost" style={{ width: '100%', marginTop: 10 }} onClick={probe} disabled={probing}>
        {probing ? '探测中…' : '🔍 重新探测所有引擎'}
      </button>

      {/* 本地模型库（按内存分档） */}
      <div className="mem-sec" style={{ marginTop: 14 }}>
        <div className="mem-sec-title">📦 本地模型库（免费 · 离线 · 无需 API）</div>
        <div className="vp-hint" style={{ marginBottom: 7 }}>
          全部为 Ollama 官方库的免费开源模型，下载后完全离线可用、不消耗任何 token。
        </div>
        {['2GB', '4GB', '6GB', '8GB', '12GB', '24GB'].map(mem => {
          const list = models.filter((m: any) => m.mem === mem);
          if (!list.length) return null;
          return (
            <div key={mem} className="mem-tier">
              <div className="mem-tier-hd">需 {mem} 内存</div>
              {list.map((m: any) => {
                const lightName = (m.light || m.name) as string;
                const fullHas = installed.includes(m.name);
                const lightIsFull = lightName === m.name;
                const lightHas = !fullHas && (installed.includes(lightName) ||
                  installed.some(x => (x || '').split(':')[0] === lightName.split(':')[0]));
                return (
                  <div className="model-row" key={m.name}>
                    <div className="model-main">
                      <div className="model-row-name">
                        {m.name}
                        {fullHas && <span className="tag-ok">已安装</span>}
                        {!fullHas && lightIsFull && lightHas && <span className="tag-ok">已安装</span>}
                        {!fullHas && !lightIsFull && (
                          <span className="tag-light">⚡ 残血版 {lightName.split(':')[1]}</span>
                        )}
                      </div>
                      <div className="model-row-meta">{m.size} · {m.lang}</div>
                      <div className="model-row-use">{m.use}</div>
                    </div>
                    {!fullHas && (
                      <div className="model-actions">
                        {!lightIsFull && (
                          <button className="btn-mini btn-accent" disabled={!!pulls[lightName]}
                            onClick={() => pullModel(lightName)} title={`下载轻量残血版 ${lightName}`}>
                            {pulls[lightName] ? `${Math.round(pulls[lightName].percent)}%` : '⚡ 残血版'}
                          </button>
                        )}
                        <button className="btn-mini" disabled={!!pulls[m.name]}
                          onClick={() => pullModel(m.name)}>
                          {pulls[m.name] ? `${Math.round(pulls[m.name].percent)}%` : '完整版'}
                        </button>
                      </div>
                    )}
                    {/* ★实时下载进度条（每个下载中的模型一行） */}
                    {(pulls[lightName] || pulls[m.name]) && (
                      <div className="dl-bar" style={{ marginTop: 5 }}>
                        <div className="dl-fill" style={{ width: `${Math.max(3, (pulls[m.name] || pulls[lightName]).percent)}%` }} />
                        <span className="dl-text">{(pulls[m.name] || pulls[lightName]).status || '下载中…'}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })}

        {bigModels.length > 0 && (
          <div className="mem-tier">
            <div className="mem-tier-hd">⚠️ 超大模型（本地跑不动，只能走云端 API）</div>
            {bigModels.map((m: any) => (
              <div className="model-row" key={m.name}>
                <div className="model-main">
                  <div className="model-row-name">{m.name}</div>
                  <div className="model-row-meta">{m.params}</div>
                  <div className="model-row-use">本地：{m.local} · 云端：{m.cloud}</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ============================================================================
 * 媒体标签页
 * ========================================================================== */
function MediaTab({ onToast, onOpenFolder }: { onToast: (m: string) => void; onOpenFolder: (p: string) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [sel, setSel] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => setItems(await window.api.media.list());
  useEffect(() => { load(); }, []);

  const upload = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      onToast(`上传 ${f.name}…`);
      const buf = await f.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf).slice(0, 30000000)));
      const r = await window.api.media.upload(f.name, b64);
      if (r.ok) onToast(`✓ ${f.name} 已保存`);
      else onToast(`✗ ${f.name}: ${r.error}`);
    }
    setBusy(false);
    load();
  };

  const probe = async (path: string) => {
    const info = await window.api.media.probe(path);
    setSel(JSON.stringify(info, null, 2));
  };

  const doOp = async (label: string, fn: () => Promise<any>) => {
    setBusy(true);
    onToast(label + '…');
    const r = await fn();
    setBusy(false);
    onToast(r?.ok ? `✓ ${label}完成` : `✗ ${label}失败：${r?.error || ''}`);
    if (r?.output) onOpenFolder(r.output);
    load();
  };

  const outDir = 'F:\\dev-ai\\output\\media';

  return (
    <div className="panel-body">
      <div className="vp-input">
        <div className="upload-drop" onClick={() => fileRef.current?.click()}
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); upload(e.dataTransfer.files); }}>
          <div className="upload-icon">📁</div>
          <div className="upload-text">
            点击或拖入文件<br />
            <small>视频 mp4/mov/avi/mkv/webm · 音频 mp3/wav/flac/m4a · 图片 jpg/png/gif/webp/svg
              <br />文档 pdf/docx/xlsx/pptx · 代码 js/ts/py/go/cpp/cs/php/rust…</small>
          </div>
        </div>
        <input ref={fileRef} type="file" multiple hidden onChange={e => upload(e.target.files)} />
      </div>

      <div className="vp-stage" style={{ marginTop: 10 }}>
        {busy ? '⏳ 处理中…' : `已上传 ${items.length} 个文件 · 全部保存到工作区 media/ 目录`}
      </div>

      <div className="media-list">
        {items.map(it => (
          <div className={`media-item ${sel ? '' : ''}`} key={it.path} onClick={() => probe(it.path)}>
            <span className={`mkind ${it.kind}`}>
              {it.kind === 'video' ? '🎬' : it.kind === 'audio' ? '🎵' :
                it.kind === 'image' ? '🖼' : it.kind === 'document' ? '📄' :
                  it.kind === 'code' ? '💻' : '📦'}
            </span>
            <span className="mname">{it.name}</span>
            <span className="msize">{it.sizeText}</span>
          </div>
        ))}
      </div>

      {/* 处理工具 */}
      {items.length > 0 && (
        <div className="media-tools">
          <div className="mem-sec-title">处理工具（选中文件后可用）</div>
          <div className="tool-grid">
            <button className="btn-mini" onClick={() => doOp('抽帧', () =>
              window.api.media.extractFrames(sel, outDir + '\\frames', 5, 60))}>抽帧</button>
            <button className="btn-mini" onClick={() => doOp('提取音频', () =>
              window.api.media.extractAudio(sel, outDir + '\\audio.mp3', 'mp3'))}>提取音频</button>
            <button className="btn-mini" onClick={() => doOp('转 GIF', () =>
              window.api.media.videoGif(sel, outDir + '\\clip.gif', 480, 12))}>转 GIF</button>
            <button className="btn-mini" onClick={() => doOp('响度归一', () =>
              window.api.media.normalize(sel, outDir + '\\norm.mp3', -14))}>响度归一</button>
            <button className="btn-mini" onClick={() => doOp('转 MP4', () =>
              window.api.media.videoOp({
                inputs: [sel], output: outDir + '\\out.mp4',
                width: 1080, height: 1920, fps: 30,
              }))}>转竖屏 MP4</button>
            <button className="btn-mini" onClick={() => doOp('转图片', () =>
              window.api.media.convertImage(sel, outDir + '\\pic.jpg', { width: 1280 }))}>转图片</button>
          </div>
          <div className="vp-hint" style={{ marginTop: 8 }}>
            点击上方文件列表查看媒体信息（时长/分辨率/编码/码率）。所有处理走本地 ffmpeg，离线免费。
          </div>
        </div>
      )}

      {sel && (
        <div className="media-info">
          <div className="mem-sec-title">媒体信息</div>
          <pre>{sel}</pre>
        </div>
      )}
    </div>
  );
}

/* ============================================================================
 * 文档标签页
 * ========================================================================== */
function DocTab({ onToast, onOpenFolder }: { onToast: (m: string) => void; onOpenFolder: (p: string) => void }) {
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState('ppt');
  const [md, setMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [fmt, setFmt] = useState('pptx');

  const KINDS = [
    { id: 'ppt', name: '演示文稿' },
    { id: 'report', name: '分析报告' },
    { id: 'doc', name: '技术文档' },
    { id: 'speech', name: '演讲稿' },
    { id: 'article', name: '长篇文章' },
  ];
  const FMTS = [
    { id: 'pptx', name: 'PPTX' }, { id: 'pdf', name: 'PDF' },
    { id: 'docx', name: 'DOCX' }, { id: 'html', name: 'HTML' },
    { id: 'md', name: 'Markdown' },
  ];

  const gen = async () => {
    setBusy(true);
    onToast('AI 生成内容…');
    const r = await window.api.doc.script(topic, kind);
    setBusy(false);
    if (!r.ok) { onToast('✗ ' + (r.error || '失败')); return; }
    setMd(r.md);
    onToast('✓ 内容已生成，可选择格式导出');
  };

  const exportDoc = async () => {
    setBusy(true);
    const r = await window.api.doc.generate(md, topic || '文档', fmt);
    setBusy(false);
    if (r.ok) { onToast(`✓ 已生成 ${r.name}`); onOpenFolder(r.output); }
    else onToast('✗ ' + (r.error || '导出失败'));
  };

  return (
    <div className="panel-body">
      <div className="vp-input">
        <textarea value={topic} onChange={e => setTopic(e.target.value)}
          placeholder="输入主题，例如：2026 年全球加密货币市场回顾" rows={3} />
        <div className="kind-row">
          {KINDS.map(k => (
            <button key={k.id} className={`kchip ${kind === k.id ? 'on' : ''}`}
              onClick={() => setKind(k.id)}>{k.name}</button>
          ))}
        </div>
        <button className="btn-primary" onClick={gen} disabled={busy || !topic.trim()}>
          {busy ? '生成中…' : '📝 AI 生成内容'}
        </button>
      </div>

      {md && (
        <>
          <div className="fmt-row">
            <span className="mem-sec-title">导出格式</span>
            {FMTS.map(f => (
              <button key={f.id} className={`kchip ${fmt === f.id ? 'on' : ''}`}
                onClick={() => setFmt(f.id)}>{f.name}</button>
            ))}
            <button className="btn-mini" onClick={exportDoc} disabled={busy}>导出</button>
          </div>
          <div className="md-preview">
            <pre>{md.slice(0, 4000)}</pre>
          </div>
        </>
      )}
    </div>
  );
}

/* ============================================================================
 * Excel 标签页
 * ========================================================================== */
function ExcelTab({ onToast, onOpenFolder }: { onToast: (m: string) => void; onOpenFolder: (p: string) => void }) {
  const [topic, setTopic] = useState('');
  const [md, setMd] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);

  const gen = async () => {
    setBusy(true);
    onToast('AI 生成表格数据…');
    const r = await window.api.excel.script(topic);
    setBusy(false);
    if (!r.ok) { onToast('✗ ' + (r.error || '失败')); return; }
    setMd(r.md);
    onToast('✓ 表格数据已生成');
  };

  const toXlsx = async () => {
    setBusy(true);
    const r = await window.api.excel.generate(md, topic || '数据');
    setBusy(false);
    if (r.ok) { onToast(`✓ 已生成 ${r.sheets?.length || 1} 个工作表`); onOpenFolder(r.output); setResult(r); }
    else onToast('✗ ' + (r.error || '导出失败'));
  };

  const readXlsx = async () => {
    const p = window.prompt('输入 .xlsx 文件的完整路径');
    if (!p) return;
    setBusy(true);
    const r = await window.api.excel.read(p);
    setBusy(false);
    if (r.ok) { setResult(r); setMd(r.md); onToast(`✓ 读取 ${r.sheets.length} 个工作表`); }
    else onToast('✗ ' + (r.error || '读取失败'));
  };

  return (
    <div className="panel-body">
      <div className="vp-input">
        <textarea value={topic} onChange={e => setTopic(e.target.value)}
          placeholder="输入数据主题，例如：2025 年全球新能源汽车销量排行" rows={3} />
        <button className="btn-primary" onClick={gen} disabled={busy || !topic.trim()}>
          {busy ? '生成中…' : '📊 AI 生成表格'}
        </button>
        <button className="btn-ghost" onClick={readXlsx} disabled={busy}>📂 读取现有 Excel</button>
      </div>

      {md && (
        <>
          <button className="btn-ok" style={{ marginTop: 10 }} onClick={toXlsx} disabled={busy}>
            💾 导出为 .xlsx
          </button>
          {result?.sheets && (
            <div className="sheets-view">
              {result.sheets.map((s: any) => (
                <div className="sheet-box" key={s.name}>
                  <div className="sheet-name">📋 {s.name}（{s.rowCount} 行 × {s.colCount} 列）</div>
                  <div className="sheet-scroll">
                    <table className="sheet-tb">
                      <thead><tr>{s.headers.map((h: string, i: number) => <th key={i}>{h}</th>)}</tr></thead>
                      <tbody>
                        {s.rows.slice(0, 20).map((r: any[], ri: number) => (
                          <tr key={ri}>{r.map((c: any, ci: number) => <td key={ci}>{String(c ?? '')}</td>)}</tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* ============================================================================
 * 批量短视频标签页
 * ========================================================================== */
const PLATFORMS = [
  { id: 'douyin', name: '抖音' }, { id: 'xiaohongshu', name: '小红书' },
  { id: 'bilibili', name: 'B站' }, { id: 'youtube', name: 'YouTube' },
  { id: 'wechat', name: '视频号' }, { id: 'general', name: '通用' },
];

function BatchTab({ onToast, onOpenFolder }: { onToast: (m: string) => void; onOpenFolder: (p: string) => void }) {
  const [topics, setTopics] = useState('');
  const [platform, setPlatform] = useState('douyin');
  const [engine, setEngine] = useState('light-local');
  const [prog, setProg] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = window.api.onBatchProgress((p: any) => setProg(p));
    window.api.batch.list().then(setProg);
    return off;
  }, []);

  const add = async () => {
    const list = topics.split('\n').map(s => s.trim()).filter(Boolean);
    if (!list.length) return;
    await window.api.batch.add(list, engine, platform);
    setTopics('');
    onToast(`✓ 已加入 ${list.length} 条选题`);
    setProg(await window.api.batch.list());
  };

  const start = async () => {
    setBusy(true);
    await window.api.batch.start();
    onToast('批量队列已启动');
    setBusy(false);
  };

  const items = prog?.items || [];
  const done = prog?.done || 0;
  const failed = prog?.failed || 0;
  const total = prog?.total || 0;

  return (
    <div className="panel-body">
      <div className="vp-intro">
        <div className="vp-icon">📦</div>
        <div>
          <b>批量短视频流水线</b>
          <div className="vp-desc">
            每行一个选题 → AI 写脚本 → 分镜 → 字幕 → 配音 → 合成 → 导出。
            支持并发控制、失败重试、进度实时显示。
          </div>
        </div>
      </div>

      <div className="vp-input">
        <textarea value={topics} onChange={e => setTopics(e.target.value)}
          placeholder={'每行一个选题，例如：\nPython 装饰器的用法\n用 Docker 部署 Node 服务\nExcel 数据透视表技巧'}
          rows={5} />
        <div className="kind-row">
          {PLATFORMS.map(p => (
            <button key={p.id} className={`kchip ${platform === p.id ? 'on' : ''}`}
              onClick={() => setPlatform(p.id)}>{p.name}</button>
          ))}
        </div>
        <div className="kind-row">
          <span className="mem-sec-title">引擎</span>
          <button className={`kchip ${engine === 'light-local' ? 'on' : ''}`}
            onClick={() => setEngine('light-local')}>本地轻量</button>
          <button className={`kchip ${engine === 'seedance-api' ? 'on' : ''}`}
            onClick={() => setEngine('seedance-api')}>Seedance API</button>
          <button className={`kchip ${engine === 'seedance-local' ? 'on' : ''}`}
            onClick={() => setEngine('seedance-local')}>Seedance 本地</button>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-primary" style={{ flex: 1 }} onClick={add} disabled={busy}>加入队列</button>
          <button className="btn-ok" style={{ flex: 1 }} onClick={start} disabled={busy || !total}>开始制作</button>
        </div>
      </div>

      {total > 0 && (
        <>
          <div className="batch-bar">
            <div className="batch-progress">
              <div className="bp-fill" style={{ width: `${(done / total) * 100}%` }} />
            </div>
            <div className="batch-stat">
              <span className="ok">完成 {done}</span>
              <span className="run">进行 {prog?.running || 0}</span>
              <span className="wait">等待 {prog?.pending || 0}</span>
              {failed > 0 && <span className="err">失败 {failed}</span>}
            </div>
          </div>

          <div className="batch-actions">
            <button className="btn-mini" onClick={() => window.api.batch.pause()}>⏸ 暂停</button>
            <button className="btn-mini" onClick={() => window.api.batch.resume()}>▶ 继续</button>
            <button className="btn-mini" onClick={() => window.api.batch.cancel()}>■ 取消</button>
            <button className="btn-mini" onClick={async () => {
              const r = await window.api.batch.retry();
              onToast(`重试 ${r.count} 条`);
            }}>↻ 重试失败</button>
            <button className="btn-mini" onClick={() => window.api.batch.clear()}>🗑 清空</button>
          </div>

          <div className="batch-list">
            {items.map((it: any) => (
              <div className={`batch-item ${it.status}`} key={it.id}>
                <div className="bi-head">
                  <span className="bi-topic">{it.topic}</span>
                  <span className={`bi-status ${it.status}`}>
                    {it.status === 'done' ? '✓' : it.status === 'failed' ? '✗' :
                      it.status === 'pending' ? '○' : '⏳'}
                  </span>
                </div>
                <div className="bi-stage">{it.stage}</div>
                {it.error && <div className="bi-err">{it.error}</div>}
                {it.output && (
                  <div className="bi-out" onClick={() => onOpenFolder(it.dir)}>
                    📁 {String(it.output).split(/[\\/]/).pop()}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
