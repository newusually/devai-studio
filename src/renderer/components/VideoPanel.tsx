/* ============================================================================
 * renderer/components/VideoPanel.tsx —— AI 短视频生成面板
 * ----------------------------------------------------------------------------
 * 流程：输入主题 → 本地 LLM 出脚本 → 生成素材包（分镜图 + SRT + 配音稿 + MP4）
 * 全部免费：本地模型 + 本地 SVG 渲染 + 本地 ffmpeg（可选）
 * ========================================================================== */
import React, { useState } from 'react';

export default function VideoPanel({ onToast }: { onToast: (m: string) => void }) {
  const [topic, setTopic] = useState('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('');
  const [result, setResult] = useState<any>(null);

  const gen = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true);
    setResult(null);
    setStage('① 本地模型生成脚本…');
    try {
      const r = await window.api.video.script(topic.trim());
      if (!r.ok) {
        onToast('✗ 脚本生成失败：' + (r.error || '未知错误'));
        setBusy(false);
        return;
      }
      const s = r.script;
      setStage(`② 脚本就绪（${s.scenes.length} 个场景）→ 生成素材…`);

      const g = await window.api.video.generate(s, 'video-' + Date.now());
      if (!g.ok) {
        onToast('✗ 素材生成失败：' + (g.error || ''));
        setBusy(false);
        return;
      }
      setResult(g);
      setStage('✓ 完成');
      onToast(g.message || '短视频素材已生成');
    } catch (e: any) {
      onToast('✗ 异常：' + (e?.message || e));
      setStage('');
    }
    setBusy(false);
  };

  return (
    <div className="panel-body vp">
      <div className="vp-intro">
        <div className="vp-icon">🎬</div>
        <div>
          <b>AI 短视频生成</b>
          <div className="vp-desc">
            本地模型出脚本 → 矢量分镜图 → 标准字幕 → 配音稿（可选 ffmpeg 合成 MP4）。
            全程免费离线，不需要任何付费 API。
          </div>
        </div>
      </div>

      <div className="vp-input">
        <textarea
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="输入短视频主题，例如：用 Python 写一个快速排序"
          rows={3}
        />
        <button className="btn-primary" onClick={gen} disabled={busy || !topic.trim()}>
          {busy ? '生成中…' : '🎬 生成短视频'}
        </button>
      </div>

      {stage && <div className="vp-stage">⏳ {stage}</div>}

      {result && (
        <div className="vp-result">
          <div className="vp-title">{result.script?.title}</div>
          {result.script?.hook && (
            <div className="vp-hook">钩子：{result.script.hook}</div>
          )}

          <div className="vp-scenes">
            {result.script?.scenes?.map((sc: any) => (
              <div className="vp-scene" key={sc.index}>
                <div className="vp-scene-hd">
                  <span className="vp-scene-no">场景 {sc.index}</span>
                  <span className="vp-scene-dur">{sc.duration}s</span>
                </div>
                <div className="vp-scene-cap">{sc.caption}</div>
                <div className="vp-scene-nar">{sc.narration}</div>
              </div>
            ))}
          </div>

          {result.script?.tags?.length > 0 && (
            <div className="vp-tags">
              {result.script.tags.map((t: string, i: number) => (
                <span className="vp-tag" key={i}>#{t}</span>
              ))}
            </div>
          )}

          <div className="vp-files">
            <div className="vp-files-title">产出文件</div>
            {(result.files || []).map((f: string, i: number) => (
              <div className="vp-file" key={i}>📄 {f.split(/[\\/]/).pop()}</div>
            ))}
          </div>

          {result.mp4 && <div className="vp-mp4">🎥 已合成 MP4：{result.mp4}</div>}
          {!result.mp4 && (
            <div className="vp-hint">
              未检测到 ffmpeg，已产出完整素材包（分镜图 + SRT 字幕 + 配音稿）。
              装 ffmpeg 后重跑即可自动合成 MP4；或用剪映 / DaVinci 直接导入素材包。
            </div>
          )}
        </div>
      )}
    </div>
  );
}
