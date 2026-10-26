/* ============================================================================
 * main/studio.ts —— 工作室服务（引擎 + 媒体 + 文档 + 批量队列）
 * ----------------------------------------------------------------------------
 * ★核心设计：按需加载（用户 2026-10-25 要求）
 *   「只有打开短视频功能才会使用这些（显卡）资源，其他都是使用没有显卡的功能」
 *
 *   → 本模块的重量级资源全部惰性：
 *     · Ollama 不启动 → 不占内存
 *     · Seedance 本地模型不启动 → 不占显存
 *     · ffmpeg 进程只在真正处理时拉起（用完即退）
 *     · 只有用户点「生成视频/批量制作」时才检测并唤醒对应引擎
 * ========================================================================== */
import { join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import {
  VIDEO_ENGINES, detectHardware, checkEngines, loadEngineSettings, saveEngineSettings,
  HardwareInfo, EngineStatus, EngineSettings, VideoEngineKind,
  probeSeedanceLocal, startSeedanceLocal,
} from './engines/video-engines';
import {
  generateVideoByApi, verifySeedanceKey, DEFAULT_SEEDANCE, SeedanceConfig,
} from './engines/seedance-api';
import {
  initMedia, mediaAvailable, probeMedia, runVideoOp, extractFrames, extractAudio,
  mixAudio, normalizeAudio, convertImage, makeGrid, videoToGif, readDocument,
  runFFmpeg, MediaInfo, VideoOp, classify, SUPPORTED_FORMATS, fmtSize, fmtDuration,
  SrtEntry,
} from './engines/media';
import {
  generateDoc, parseMarkdownToDoc, DocModel,
} from './engines/docs';
import {
  BatchVideoQueue, BatchOptions, BatchItem, BatchProgress,
  PLATFORM_SPEC, buildBatchScriptPrompt,
} from './engines/batch-video';
import {
  TEMPLATES, SceneTemplate, SubtitleStyle, getTemplate, getSubtitleStyle,
  renderSceneSvgTpl,
} from './engines/templates';
import { parseVideoScript } from './agents/video';
import { ProviderRegistry } from './providers';

export class Studio {
  private settings: EngineSettings;
  private hw: HardwareInfo;
  private batch: BatchVideoQueue | null = null;
  private mediaRoot = '';
  private outRoot = '';

  constructor(
    private dataDir: string,
    private registry: ProviderRegistry,
    private workspace: string,
    private emit: (channel: string, payload: any) => void
  ) {
    this.settings = loadEngineSettings(join(dataDir, 'engines.json'));
    this.hw = detectHardware();
    this.mediaRoot = join(workspace, 'media');
    this.outRoot = join(workspace, 'output');
    try {
      if (!existsSync(this.mediaRoot)) mkdirSync(this.mediaRoot, { recursive: true });
      if (!existsSync(this.outRoot)) mkdirSync(this.outRoot, { recursive: true });
    } catch (e) { }
    initMedia();
  }

  /* ---------------- 引擎 ---------------- */
  listEngines() {
    return {
      engines: VIDEO_ENGINES,
      status: checkEngines(this.hw, this.settings.keys, { seedanceLocalPath: this.settings.seedanceLocalPath }),
      hardware: this.hw,
      current: this.settings.current,
      ffmpeg: mediaAvailable(),
      formats: SUPPORTED_FORMATS,
    };
  }

  setEngine(kind: VideoEngineKind) {
    this.settings.current = kind;
    this.save();
    return { ok: true, current: kind };
  }

  setKey(kind: string, key: string) {
    this.settings.keys[kind] = key;
    this.save();
    return { ok: true, kind, hasKey: !!key };
  }

  setEngineOption(opt: Partial<EngineSettings>) {
    Object.assign(this.settings, opt);
    this.save();
    return { ok: true };
  }

  private save() {
    saveEngineSettings(join(this.dataDir, 'engines.json'), this.settings);
  }

  /** 探测各引擎（不启动任何重型进程） */
  async probeEngines() {
    const statuses = checkEngines(this.hw, this.settings.keys, { seedanceLocalPath: this.settings.seedanceLocalPath });
    const out: any[] = [];
    for (const s of statuses) {
      let extra = '';
      if (s.kind === 'seedance-local') {
        const info = await probeSeedanceLocal(this.settings.seedanceLocalPath, this.settings.seedanceLocalApi);
        extra = info.detail;
        s.installed = info.installed;
      } else if (s.kind === 'seedance-api' && s.hasKey) {
        const r = await verifySeedanceKey(this.seedanceConfig());
        extra = r.message;
        s.available = r.ok;
        if (!r.ok) s.reason = r.message;
      } else if (s.kind === 'light-local') {
        extra = mediaAvailable() ? 'ffmpeg 就绪' : 'ffmpeg 不可用';
      }
      out.push({ ...s, extra });
    }
    return { hardware: this.hw, status: out };
  }

  /** ★按需启动本地 Seedance（用户手动触发才启动） */
  async startLocalEngine() {
    const r = await startSeedanceLocal(this.settings.seedanceLocalPath);
    if (r.ok) {
      this.emit('studio:log', { level: 'info', text: r.message });
    }
    return r;
  }

  private seedanceConfig(): SeedanceConfig {
    return {
      ...DEFAULT_SEEDANCE,
      apiKey: this.settings.keys['seedance-api'] || '',
      baseUrl: this.settings.volcengineApi,
      model: this.settings.keys['seedance-model'] || DEFAULT_SEEDANCE.model,
      duration: 5,
      resolution: '720p',
      watermark: false,
      pollIntervalMs: 4000,
      timeoutMs: 300000,
    };
  }

  /* ---------------- 媒体 ---------------- */
  listMedia() {
    const items: any[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 3 || items.length > 500) return;
      let entries: string[] = [];
      try { entries = readdirSync(dir); } catch { return; }
      for (const e of entries) {
        if (e.startsWith('.')) continue;
        const full = join(dir, e);
        try {
          const st = statSync(full);
          if (st.isDirectory()) walk(full, depth + 1);
          else {
            items.push({
              path: full,
              name: e,
              kind: classify(e),
              size: st.size,
              sizeText: fmtSize(st.size),
              mtime: st.mtimeMs,
            });
          }
        } catch { }
      }
    };
    walk(this.mediaRoot, 0);
    return items.sort((a, b) => b.mtime - a.mtime);
  }

  /** 保存上传的文件（base64 或本地路径） */
  saveUploaded(name: string, dataBase64: string): { ok: boolean; path?: string; error?: string } {
    try {
      const safe = name.replace(/[\\/:*?"<>|]/g, '_');
      const dest = join(this.mediaRoot, safe);
      const buf = Buffer.from(dataBase64, 'base64');
      writeFileSync(dest, buf);
      return { ok: true, path: dest };
    } catch (e: any) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async probe(file: string) { return probeMedia(file); }

  async videoOp(op: VideoOp) { return runVideoOp(op, (s) => this.emit('studio:log', { level: 'info', text: s })); }
  async frames(input: string, dir: string, every: number, max: number) {
    return extractFrames(input, dir, every, max);
  }
  async audio(input: string, out: string, fmt: string) { return extractAudio(input, out, fmt); }
  async mix(inputs: string[], out: string, vols?: number[]) { return mixAudio(inputs, out, vols); }
  async normalize(input: string, out: string, lufs?: number) { return normalizeAudio(input, out, lufs); }
  async imgConvert(input: string, out: string, opts?: any) { return convertImage(input, out, opts); }
  async grid(inputs: string[], out: string, cols: number, w: number) { return makeGrid(inputs, out, cols, w); }
  async gif(input: string, out: string, w?: number, fps?: number) { return videoToGif(input, out, w, fps); }
  async readDoc(file: string) { return readDocument(file); }

  /* ---------------- 文档 ---------------- */
  /** AI 生成文档脚本（Markdown） */
  async docScript(topic: string, kind: string): Promise<{ ok: boolean; md?: string; error?: string }> {
    const provider = this.registry.create();
    if (!provider) return { ok: false, error: '没有可用模型' };
    try {
      const resolved = await this.registry.resolveModel(provider.kind);
      if (resolved) (provider as any).model = resolved;
    } catch { }

    const kindSpec: Record<string, string> = {
      ppt: '做一份演示文稿（PPT）的内容大纲：每页一个标题 + 3-5 个要点',
      report: '做一份结构化报告：背景、现状、问题、方案、结论、数据支撑',
      doc: '做一份技术文档：概述、详细设计、接口说明、示例代码、常见问题',
      speech: '做一份演讲稿/口播稿：开场、主体分段、结尾',
      article: '做一篇长文：引子、主体分节、结语',
    };

    const sys = `你是资深文档撰写者。请按【Markdown】输出，不要任何解释性前言。

文档类型：${kindSpec[kind] || kindSpec.doc}
主题：${topic}

要求：
- 用 Markdown 结构化输出（# / ## / ### 标题，- 列表，> 引用，表格，代码块）
- 内容具体、有信息量，不要空话套话
- 适当使用表格和代码块增强表达
- 全中文输出`;

    const res = await provider.chat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }],
      temperature: 0.4,
      maxTokens: 4000,
    });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, md: res.content };
  }

  /** 生成文档文件 */
  async generateDocFile(
    md: string, title: string, format: 'md' | 'html' | 'pptx' | 'docx' | 'pdf',
    outName?: string
  ) {
    const doc: DocModel = parseMarkdownToDoc(md, title);
    const ext = format === 'pptx' ? 'pptx' : format;
    const name = (outName || sanitize(doc.title) || 'document') + '.' + ext;
    const out = join(this.outRoot, name);
    const r = await generateDoc(doc, out, format);
    if (r.ok) this.emit('studio:log', { level: 'info', text: `文档已生成：${name}` });
    return { ...r, name, doc };
  }

  /* ---------------- 多模板批量导出（同一脚本 → 多个风格版本） ---------------- */
  async renderMultiTemplates(
    script: any,
    templateIds: string[],
    subtitleStyleId?: string
  ): Promise<{ ok: boolean; results: Array<{ template: string; dir: string; video?: string; files: string[] }>; error?: string }> {
    const out: Array<{ template: string; dir: string; video?: string; files: string[] }> = [];
    try {
      for (const tid of templateIds) {
        const tpl = getTemplate(tid);
        const dir = join(this.outRoot, 'multi', `${tid}-${Date.now()}`);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        const files: string[] = [];
        const r = await this.renderLocal(script, dir, files, {
          templateId: tid,
          subtitleStyleId: subtitleStyleId || this.settings.subtitleStyleId,
        });
        out.push({ template: tpl.name, dir: r.dir, video: r.video, files: r.files });
        this.emit('studio:log', { level: 'info', text: `✓ 模板「${tpl.name}」完成` });
      }
      return { ok: true, results: out };
    } catch (e: any) {
      return { ok: false, results: out, error: e?.message || String(e) };
    }
  }

  /* ---------------- 批量短视频 ---------------- */
  private ensureBatch(): BatchVideoQueue {
    if (!this.batch) {
      const opts: BatchOptions = {
        outDir: this.outRoot,
        concurrency: this.settings.batchConcurrency || 2,
        duration: 5,
        resolution: '720p',
        withVoice: true,
        platform: 'general',
        maxRetries: 2,
      };
      this.batch = new BatchVideoQueue(opts);
      this.batch.on('progress', (p: BatchProgress) => {
        this.emit(IPC_BATCH_PROGRESS, p);
      });
    }
    return this.batch;
  }

  addBatchTopics(topics: string[], engine: VideoEngineKind, platform: BatchItem['platform']) {
    return this.ensureBatch().addTopics(topics, engine, platform);
  }

  getBatch(): BatchProgress { return this.ensureBatch().getProgress(); }
  batchPause() { this.ensureBatch().pause(); }
  batchResume() { this.ensureBatch().resume(); }
  batchCancel() { this.ensureBatch().cancel(); }
  batchClear() { this.ensureBatch().clear(); }
  batchRetry(): number { return this.ensureBatch().retryFailed(); }

  /** 启动批量队列 */
  async startBatch() {
    const q = this.ensureBatch();
    const registry = this.registry;

    const scriptFn = async (topic: string, platform: string, req?: string) => {
      const provider = registry.create();
      if (!provider) throw new Error('没有可用模型');
      try {
        const resolved = await registry.resolveModel(provider.kind);
        if (resolved) (provider as any).model = resolved;
      } catch { }
      const prompt = buildBatchScriptPrompt(topic, platform, req);
      const res = await provider.chat({
        messages: [{ role: 'system', content: '你是短视频内容策划，只输出 JSON。' },
        { role: 'user', content: prompt }],
        temperature: 0.75, maxTokens: 2500,
      });
      if (res.error) throw new Error(res.error);
      const s = parseVideoScript(res.content);
      if (!s) throw new Error('脚本解析失败');
      return s;
    };

    const renderFn = async (script: any, item: BatchItem) => {
      const dir = join(this.outRoot, 'batch', item.id);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const r = await this.renderScriptToVideo(script, dir, item);
      return r;
    };

    q.start(scriptFn as any, renderFn as any);
    return { ok: true };
  }

  /** ★核心渲染：脚本 → 素材 → 合成视频（支持多引擎） */
  async renderScriptToVideo(script: any, dir: string, item?: BatchItem) {
    const engine = item?.engine || this.settings.current;
    const files: string[] = [];
    let video: string | undefined;

    this.emit('studio:log', { level: 'info', text: `渲染引擎：${engine}` });

    /* ① 引擎分支 */
    if (engine === 'seedance-api') {
      const cfg = this.seedanceConfig();
      const prompt = script.scenes?.map((s: any) => s.narration || s.caption).join(' ') || script.title || '';
      const r = await generateVideoByApi(cfg, prompt, (s) => this.emit('studio:log', { level: 'info', text: s }));
      if (!r.ok) {
        // ★优雅降级：云端失败 → 本地轻量
        this.emit('studio:log', { level: 'warn', text: `云端生成失败（${r.error}），自动切换本地轻量模式` });
        return this.renderLocal(script, dir, files);
      }
      // 下载视频
      if (r.videoUrl) {
        const out = join(dir, 'video.mp4');
        const dl = await downloadFile(r.videoUrl, out);
        if (dl.ok) { video = out; files.push(out); }
      }
      // 同时产出字幕与脚本
      files.push(...this.writeSidecar(script, dir));
      return { dir, files, video };
    }

    if (engine === 'seedance-local') {
      // 本地 Seedance：调它自带的 API（与 OpenAI 兼容接口类似）
      const r = await this.renderSeedanceLocal(script, dir);
      if (r.ok) return r;
      this.emit('studio:log', { level: 'warn', text: '本地 Seedance 不可用，切换本地轻量模式' });
    }

    /* ② 本地轻量：SVG 分镜 + SRT + ffmpeg */
    return this.renderLocal(script, dir, files);
  }

  /** 本地轻量渲染 */
  private async renderLocal(
    script: any, dir: string, files: string[],
    opts?: { templateId?: string; subtitleStyleId?: string }
  ): Promise<{ dir: string; files: string[]; video?: string }> {
    let video: string | undefined;
    const tpl = getTemplate(opts?.templateId || this.settings.templateId || 'tech');
    const sub = getSubtitleStyle(opts?.subtitleStyleId || this.settings.subtitleStyleId || 'bold-white');
    const imgDir = join(dir, 'scenes');
    if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });

    const total = script.scenes.length;
    script.scenes.forEach((s: any, i: number) => {
      const p = join(imgDir, `scene-${String(i + 1).padStart(2, '0')}.svg`);
      writeFileSync(p, renderSceneSvgTpl({ ...s, index: i + 1 }, script.title, total, tpl, sub), 'utf8');
      files.push(p);
    });

    // SRT
    const srtPath = join(dir, 'subtitles.srt');
    const entries = buildEntries(script.scenes);
    writeFileSync(srtPath, srtEntriesToSrt(entries), 'utf8');
    files.push(srtPath);

    // 配音稿
    const voicePath = join(dir, 'voiceover.txt');
    writeFileSync(voicePath,
      script.scenes.map((s: any, i: number) => `【场景 ${i + 1}】(${s.duration}s)\n${s.narration}`).join('\n\n'),
      'utf8');
    files.push(voicePath);

    // 脚本 JSON
    const jsonPath = join(dir, 'script.json');
    writeFileSync(jsonPath, JSON.stringify(script, null, 2), 'utf8');
    files.push(jsonPath);

    // 合成 MP4（需要 SVG → PNG，ffmpeg 直接吃 SVG 需要 librsvg，Windows 版通常没有）
    // 策略：先把 SVG 转 PNG（ffmpeg 对 SVG 支持有限 → 用 Electron 渲染截图更可靠）
    const pngDir = join(dir, 'png');
    if (!existsSync(pngDir)) mkdirSync(pngDir, { recursive: true });
    const pngs = await this.renderSvgToPng(script, pngDir, total, opts);
    if (pngs.length) {
      const mp4 = join(dir, 'video.mp4');
      const listPath = join(dir, 'frames.txt');
      const lines: string[] = [];
      pngs.forEach((p, i) => {
        const dur = script.scenes[i]?.duration || 5;
        lines.push(`file '${p.replace(/\\/g, '/')}'`);
        lines.push(`duration ${dur}`);
      });
      lines.push(`file '${pngs[pngs.length - 1].replace(/\\/g, '/')}'`);
      writeFileSync(listPath, lines.join('\n'), 'utf8');

      const args = [
        '-y', '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '24',
        '-movflags', '+faststart', mp4,
      ];
      const r = await runFFmpeg(args, undefined, 120000);
      if (r.ok) {
        video = mp4;
        files.push(mp4);
        this.emit('studio:log', { level: 'info', text: `✓ 合成完成：${mp4}` });
      } else {
        this.emit('studio:log', { level: 'warn', text: `MP4 合成失败：${r.error}（素材包已生成）` });
      }
    }

    return { dir, files, video };
  }

  /** SVG → PNG（用 Electron 的 Chromium 渲染，Windows 版 ffmpeg 不支持 SVG） */
  private async renderSvgToPng(
    script: any, outDir: string, total: number,
    opts?: { templateId?: string; subtitleStyleId?: string }
  ): Promise<string[]> {
    const out: string[] = [];
    let win: any = null;
    try {
      const { BrowserWindow } = require('electron');
      const tpl = getTemplate(opts?.templateId || this.settings.templateId || 'tech');
      const sub = getSubtitleStyle(opts?.subtitleStyleId || this.settings.subtitleStyleId || 'bold-white');
      /* ★修复（2026-10-25）：之前用 offscreen:true + capturePage()，
       *   Electron 离屏模式下 capturePage 经常【不返回 / 卡死】，导致整个
       *   视频生成永远停在"生成中…"。改为普通隐藏窗口（show:false），
       *   隐藏窗口正常参与合成，capturePage 稳定可用。 */
      win = new BrowserWindow({
        width: 1080, height: 1920, show: false,
        webPreferences: {
          sandbox: false,
          contextIsolation: true,
          nodeIntegration: false,
          backgroundThrottling: false,
        },
      });
      win.on('closed', () => { win = null; });
      for (let i = 0; i < total; i++) {
        const s = script.scenes[i];
        const svg = renderSceneSvgTpl({ ...s, index: i + 1 }, script.title, total, tpl, sub);
        // 内联 SVG 直接渲染（避免 <img> 异步解码竞态）
        const html =
          `<!doctype html><html><head><meta charset="utf-8">` +
          `<style>html,body{margin:0;padding:0;width:1080px;height:1920px;overflow:hidden;background:#000}</style>` +
          `</head><body>${svg}</body></html>`;
        await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
        await new Promise<void>((r) => setTimeout(r, 200));   // 等布局/绘制完成
        const png = await this.captureWithTimeout(win, 10000);
        if (png && png.length) {
          const p = join(outDir, `scene-${String(i + 1).padStart(2, '0')}.png`);
          writeFileSync(p, png);
          out.push(p);
        } else {
          this.emit('studio:log', { level: 'warn', text: `场景 ${i + 1} 截图为空，跳过该帧` });
        }
      }
    } catch (e: any) {
      this.emit('studio:log', { level: 'warn', text: `SVG→PNG 渲染失败：${e?.message || e}` });
    } finally {
      if (win && !win.isDestroyed()) { try { win.destroy(); } catch { } }
    }
    return out;
  }

  /** 带超时保护的截图：capturePage 万一卡死（离屏/驱动问题）也不会让整个流程挂起 */
  private captureWithTimeout(win: any, ms: number): Promise<Buffer | null> {
    const cap = Promise.resolve()
      .then(() => win.webContents.capturePage())
      .then((img: any) => (img && typeof img.toPNG === 'function' ? img.toPNG() : null))
      .catch(() => null as Buffer | null);
    const to = new Promise<null>((resolve) => {
      setTimeout(() => {
        this.emit('studio:log', { level: 'warn', text: `截图超时（${ms / 1000}s），终止该窗口` });
        try { if (win && !win.isDestroyed()) win.destroy(); } catch { }
        resolve(null);
      }, ms);
    });
    return Promise.race<Buffer | null>([cap, to]);
  }

  /** 本地 Seedance 调用（它自带 OpenAI 兼容 API） */
  private async renderSeedanceLocal(script: any, dir: string) {
    const api = this.settings.seedanceLocalApi;
    const model = this.settings.keys['seedance-local-model'] || 'seedance-2.0';
    const prompt = script.scenes?.map((s: any) => s.narration || s.caption).join(' ') || script.title || '';
    try {
      const res = await fetch(`${api}/v1/videos/generations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          duration: 5,
          size: '720x1280',
        }),
      });
      if (!res.ok) return { ok: false };
      const j: any = await res.json();
      const url = j?.data?.[0]?.url || j?.url;
      if (!url) return { ok: false };
      const out = join(dir, 'video.mp4');
      const dl = await downloadFile(url, out);
      if (!dl.ok) return { ok: false };
      return { ok: true, dir, files: [out], video: out };
    } catch (e) {
      return { ok: false };
    }
  }

  private writeSidecar(script: any, dir: string): string[] {
    const files: string[] = [];
    try {
      const srtPath = join(dir, 'subtitles.srt');
      writeFileSync(srtPath, srtEntriesToSrt(buildEntries(script.scenes)), 'utf8');
      files.push(srtPath);
      const jsonPath = join(dir, 'script.json');
      writeFileSync(jsonPath, JSON.stringify(script, null, 2), 'utf8');
      files.push(jsonPath);
      const voicePath = join(dir, 'voiceover.txt');
      writeFileSync(voicePath, script.scenes?.map((s: any, i: number) =>
        `【场景 ${i + 1}】(${s.duration}s)\n${s.narration}`).join('\n\n') || '', 'utf8');
      files.push(voicePath);
    } catch (e) { }
    return files;
  }
}

/* ---------------- 工具 ---------------- */
function sanitize(s: string): string {
  return (s || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

function buildEntries(scenes: any[]): SrtEntry[] {
  const out: SrtEntry[] = [];
  let t = 0;
  for (const s of scenes || []) {
    const dur = s.duration || 5;
    out.push({ start: t, end: t + dur, text: s.caption || s.narration || '' });
    t += dur;
  }
  return out;
}

function srtEntriesToSrt(entries: SrtEntry[]): string {
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return entries.map((e, i) => `${i + 1}\n${fmt(e.start)} --> ${fmt(e.end)}\n${e.text}\n`).join('\n');
}

async function downloadFile(url: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

const IPC_BATCH_PROGRESS = 'batch:progress';
