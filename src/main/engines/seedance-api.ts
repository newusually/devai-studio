/* ============================================================================
 * main/engines/seedance-api.ts —— Seedance 官方 API 客户端（火山引擎）
 * ----------------------------------------------------------------------------
 * 豆包 Seedance 2.5 官方 API（Ark 平台）
 *   基础地址：https://ark.cn-beijing.volces.com/api/v3
 *   视频生成：POST /contents/generations/tasks   （异步任务）
 *   查询任务：GET  /contents/generations/tasks/{id}
 *   图生视频：首帧图走 images 字段（base64 或 URL）
 *
 * 费用：火山引擎给新用户免费额度（以官方为准），本程序不额外收费。
 * 该引擎不需要显卡，本机 8G 内存也能跑。
 *
 * ★按需调用：只有用户点"生成视频"才会请求，闲时不占任何资源。
 * ========================================================================== */
import { fetchWithTimeout } from '../providers/types';

export interface SeedanceTask {
  id: string;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  /** 生成结果的视频 URL */
  videoUrl?: string;
  /** 首帧图片（若模型返回） */
  firstFrameUrl?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** 原始响应 */
  raw?: any;
}

export interface SeedanceConfig {
  apiKey: string;
  baseUrl: string;
  /** 模型 endpoint id（火山引擎控制台里创建的推理接入点 id） */
  model: string;
  /** 视频时长（秒） */
  duration: number;
  /** 分辨率 */
  resolution: '480p' | '720p' | '1080p';
  /** 是否生成水印 */
  watermark: boolean;
  /** 参考图（base64 data URL 或 https URL），用于图生视频 */
  imageUrl?: string;
  /** 轮询间隔 */
  pollIntervalMs: number;
  /** 超时 */
  timeoutMs: number;
}

export const DEFAULT_SEEDANCE: SeedanceConfig = {
  apiKey: '',
  baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
  model: 'doubao-seedance-2-0-250828',
  duration: 5,
  resolution: '720p',
  watermark: false,
  pollIntervalMs: 4000,
  timeoutMs: 300000,
};

/* ---------------- 提交任务 ---------------- */
export async function createSeedanceTask(
  cfg: SeedanceConfig,
  prompt: string,
  onLog?: (s: string) => void
): Promise<{ ok: boolean; taskId?: string; error?: string; raw?: any }> {
  if (!cfg.apiKey) return { ok: false, error: '未配置火山引擎 API Key' };
  if (!cfg.model) return { ok: false, error: '未配置模型 endpoint id（火山引擎控制台 → 开通推理 → 复制 endpoint id）' };

  const body: any = {
    model: cfg.model,
    content: [
      { type: 'text', text: prompt },
    ],
    ratio: 'adaptive',
    duration: cfg.duration,
    resolution: cfg.resolution,
    watermark: cfg.watermark,
  };

  // 图生视频：首帧图
  if (cfg.imageUrl) {
    body.content.push({ type: 'image_url', image_url: { url: cfg.imageUrl } });
    onLog?.(`已附加参考图（${cfg.imageUrl.slice(0, 40)}…）`);
  }

  onLog?.(`提交任务：${cfg.model} · ${cfg.duration}s · ${cfg.resolution}`);

  try {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/contents/generations/tasks`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${cfg.apiKey}`,
        },
        body: JSON.stringify(body),
      },
      60000
    );
    const txt = await res.text();
    let j: any;
    try { j = JSON.parse(txt); } catch { j = { raw: txt }; }

    if (!res.ok) {
      const msg = j?.error?.message || j?.error?.msg || `HTTP ${res.status}: ${txt.slice(0, 300)}`;
      onLog?.(`提交失败：${msg}`);
      return { ok: false, error: msg, raw: j };
    }
    const id = j?.id || j?.data?.id;
    if (!id) return { ok: false, error: '未返回任务 id', raw: j };
    onLog?.(`任务已创建：${id}`);
    return { ok: true, taskId: id, raw: j };
  } catch (e: any) {
    const msg = e?.message || String(e);
    onLog?.(`提交异常：${msg}`);
    return { ok: false, error: msg };
  }
}

/* ---------------- 查询任务 ---------------- */
export async function querySeedanceTask(
  cfg: SeedanceConfig,
  taskId: string
): Promise<SeedanceTask> {
  const t: SeedanceTask = {
    id: taskId, status: 'queued', createdAt: Date.now(), updatedAt: Date.now(),
  };
  try {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/contents/generations/tasks/${taskId}`,
      { headers: { 'Authorization': `Bearer ${cfg.apiKey}` } },
      30000
    );
    const j: any = await res.json();
    t.raw = j;
    if (!res.ok) {
      t.status = 'failed';
      t.error = j?.error?.message || `HTTP ${res.status}`;
      return t;
    }
    const st = (j?.status || j?.data?.status || '').toLowerCase();
    t.status = (['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(st)
      ? st : 'running') as SeedanceTask['status'];
    t.videoUrl = j?.content?.video_url || j?.data?.content?.video_url || j?.video_url;
    t.firstFrameUrl = j?.content?.first_frame_url || j?.data?.content?.first_frame_url;
    t.error = j?.error?.message;
    t.updatedAt = Date.now();
    return t;
  } catch (e: any) {
    t.status = 'running';
    t.error = e?.message;
    return t;
  }
}

/* ---------------- 等待完成 ---------------- */
export async function waitSeedanceTask(
  cfg: SeedanceConfig,
  taskId: string,
  onLog?: (s: string) => void
): Promise<SeedanceTask> {
  const t0 = Date.now();
  let lastStatus = '';
  while (Date.now() - t0 < cfg.timeoutMs) {
    const t = await querySeedanceTask(cfg, taskId);
    if (t.status !== lastStatus) {
      lastStatus = t.status;
      onLog?.(`任务状态：${t.status}`);
    }
    if (t.status === 'succeeded') return t;
    if (t.status === 'failed' || t.status === 'cancelled') {
      onLog?.(`任务失败：${t.error || t.status}`);
      return t;
    }
    await new Promise(r => setTimeout(r, cfg.pollIntervalMs));
  }
  return {
    id: taskId, status: 'failed', createdAt: Date.now(), updatedAt: Date.now(),
    error: `等待超时（${Math.round(cfg.timeoutMs / 1000)} 秒）`,
  };
}

/* ---------------- 一站式：文生视频 ---------------- */
export async function generateVideoByApi(
  cfg: SeedanceConfig,
  prompt: string,
  onLog?: (s: string) => void
): Promise<{ ok: boolean; videoUrl?: string; error?: string; taskId?: string; durationMs: number }> {
  const t0 = Date.now();
  const sub = await createSeedanceTask(cfg, prompt, onLog);
  if (!sub.ok || !sub.taskId) {
    return { ok: false, error: sub.error, durationMs: Date.now() - t0 };
  }
  const done = await waitSeedanceTask(cfg, sub.taskId, onLog);
  if (done.status === 'succeeded' && done.videoUrl) {
    onLog?.(`生成完成：${done.videoUrl}`);
    return { ok: true, videoUrl: done.videoUrl, taskId: sub.taskId, durationMs: Date.now() - t0 };
  }
  return {
    ok: false, error: done.error || '生成失败', taskId: sub.taskId, durationMs: Date.now() - t0,
  };
}

/* ---------------- 密钥校验 ---------------- */
export async function verifySeedanceKey(cfg: SeedanceConfig): Promise<{ ok: boolean; message: string }> {
  if (!cfg.apiKey) return { ok: false, message: '未配置 API Key' };
  try {
    const res = await fetchWithTimeout(
      `${cfg.baseUrl}/models`,
      { headers: { 'Authorization': `Bearer ${cfg.apiKey}` } },
      15000
    );
    if (res.ok) {
      const j: any = await res.json();
      const n = (j.data || []).length;
      return { ok: true, message: `鉴权成功 · 可见模型 ${n} 个` };
    }
    const t = await res.text().catch(() => '');
    let msg = `HTTP ${res.status}`;
    try { const e = JSON.parse(t); msg = e?.error?.message || msg; } catch { }
    return { ok: false, message: msg };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}
