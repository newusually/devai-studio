/* ============================================================================
 * main/engines/batch-video.ts —— 批量短视频生产流水线
 * ----------------------------------------------------------------------------
 * 用户需求："可以制作短视频 并且有自动制作批量短视频的功能"
 *
 * 流水线：
 *   选题（批量导入） → 每条独立：脚本(LLM) → 分镜(SVG/图像) → 配音(TTS)
 *                        → 字幕(SRT) → BGM 混音 → ffmpeg 合成 → 导出
 *
 * 特性：
 *   · 队列管理（暂停/继续/取消/重试）
 *   · 并发控制（默认 2，避免打爆 4 核 CPU）
 *   · 失败重试（指数退避）
 *   · 实时进度事件推送
 *   · 支持多引擎（每个任务可单独指定引擎）
 * ========================================================================== */
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { VideoEngineKind } from './video-engines';
import { runVideoOp, extractAudio, mixAudio, buildSrt, SrtEntry } from './media';

export interface BatchItem {
  id: string;
  /** 选题 */
  topic: string;
  /** 额外要求 */
  requirement?: string;
  /** 使用的引擎 */
  engine: VideoEngineKind;
  /** 平台适配 */
  platform: 'douyin' | 'xiaohongshu' | 'bilibili' | 'youtube' | 'wechat' | 'general';
  /** 状态 */
  status: 'pending' | 'scripting' | 'rendering' | 'composing' | 'done' | 'failed' | 'canceled';
  /** 进度 0-100 */
  progress: number;
  /** 当前阶段说明 */
  stage: string;
  /** 错误 */
  error?: string;
  /** 产出文件 */
  output?: string;
  /** 产出目录 */
  dir?: string;
  /** 脚本 */
  script?: any;
  /** 耗时（毫秒） */
  durationMs?: number;
  /** 重试次数 */
  retries: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
}

export interface BatchOptions {
  /** 输出根目录 */
  outDir: string;
  /** 并发数 */
  concurrency: number;
  /** 视频时长（秒） */
  duration: number;
  /** 分辨率 */
  resolution: '480p' | '720p' | '1080p';
  /** 是否配音 */
  withVoice: boolean;
  /** 背景音乐 */
  bgm?: string;
  /** 平台 */
  platform: BatchItem['platform'];
  /** 最大重试次数 */
  maxRetries: number;
}

export interface BatchProgress {
  total: number;
  done: number;
  failed: number;
  running: number;
  pending: number;
  items: BatchItem[];
}

export class BatchVideoQueue extends EventEmitter {
  private items: BatchItem[] = [];
  private running = new Set<string>();
  private paused = false;
  private canceled = false;
  private opts: BatchOptions;

  constructor(opts: BatchOptions) {
    super();
    this.opts = opts;
  }

  /** 批量导入选题 */
  addTopics(topics: string[], engine: VideoEngineKind, platform: BatchItem['platform']): BatchItem[] {
    const added: BatchItem[] = [];
    for (const t of topics) {
      if (!t || !t.trim()) continue;
      const item: BatchItem = {
        id: `b${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
        topic: t.trim(),
        engine,
        platform,
        status: 'pending',
        progress: 0,
        stage: '排队中',
        retries: 0,
        createdAt: Date.now(),
      };
      this.items.push(item);
      added.push(item);
    }
    this.emitProgress();
    return added;
  }

  /** 从文本批量解析（一行一个，或逗号分隔） */
  addFromText(text: string, engine: VideoEngineKind, platform: BatchItem['platform']): BatchItem[] {
    const topics = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return this.addTopics(topics, engine, platform);
  }

  getItems(): BatchItem[] { return this.items; }

  getProgress(): BatchProgress {
    const done = this.items.filter(i => i.status === 'done').length;
    const failed = this.items.filter(i => i.status === 'failed').length;
    return {
      total: this.items.length,
      done, failed,
      running: this.running.size,
      pending: this.items.filter(i => i.status === 'pending').length,
      items: this.items.map(i => ({ ...i })),
    };
  }

  private emitProgress() {
    this.emit('progress', this.getProgress());
  }

  pause() { this.paused = true; this.emitProgress(); }
  resume() { this.paused = false; this.pump(); this.emitProgress(); }
  cancel() {
    this.canceled = true;
    for (const i of this.items) {
      if (i.status === 'pending' || i.status === 'scripting' || i.status === 'rendering') {
        i.status = 'canceled';
        i.stage = '已取消';
      }
    }
    this.emitProgress();
  }

  /** 重试失败项 */
  retryFailed(): number {
    let n = 0;
    for (const i of this.items) {
      if (i.status === 'failed') {
        i.status = 'pending';
        i.progress = 0;
        i.stage = '排队中';
        i.error = undefined;
        i.retries = 0;
        n++;
      }
    }
    this.canceled = false;
    this.paused = false;
    this.pump();
    this.emitProgress();
    return n;
  }

  clear() {
    this.items = [];
    this.emitProgress();
  }

  /** 启动队列 */
  start(
    scriptFn: (topic: string, platform: string, req?: string) => Promise<any>,
    renderFn: (script: any, item: BatchItem) => Promise<{ dir: string; files: string[]; video?: string }>
  ) {
    this.canceled = false;
    this.paused = false;
    this.pump(scriptFn, renderFn);
  }

  private pump(scriptFn?: any, renderFn?: any) {
    if (this.canceled || this.paused) return;
    if (!scriptFn || !renderFn) return;

    while (this.running.size < this.opts.concurrency) {
      const next = this.items.find(i => i.status === 'pending');
      if (!next) break;
      this.running.add(next.id);
      this.processOne(next, scriptFn, renderFn)
        .finally(() => {
          this.running.delete(next.id);
          this.emitProgress();
          this.pump(scriptFn, renderFn);
        });
    }
  }

  private async processOne(
    item: BatchItem,
    scriptFn: (t: string, p: string, r?: string) => Promise<any>,
    renderFn: (s: any, i: BatchItem) => Promise<{ dir: string; files: string[]; video?: string }>
  ) {
    const t0 = Date.now();
    item.startedAt = t0;
    try {
      /* ① 脚本 */
      item.status = 'scripting';
      item.stage = 'AI 生成脚本…';
      item.progress = 10;
      this.emitProgress();

      const script = await scriptFn(item.topic, item.platform, item.requirement);
      if (!script) throw new Error('脚本生成失败');
      item.script = script;

      /* ② 渲染 */
      item.status = 'rendering';
      item.stage = '生成分镜与素材…';
      item.progress = 35;
      this.emitProgress();

      const r = await renderFn(script, item);
      item.dir = r.dir;
      item.output = r.video || r.files[0];
      item.progress = 90;
      item.stage = '合成中…';
      this.emitProgress();

      /* ③ 完成 */
      item.status = 'done';
      item.progress = 100;
      item.stage = '完成';
      item.durationMs = Date.now() - t0;
      item.finishedAt = Date.now();
    } catch (e: any) {
      item.retries++;
      if (item.retries <= this.opts.maxRetries) {
        item.status = 'pending';
        item.stage = `失败重试（${item.retries}/${this.opts.maxRetries}）`;
        item.error = e?.message || String(e);
        // 指数退避
        await new Promise(r => setTimeout(r, Math.min(10000, 1000 * Math.pow(2, item.retries))));
      } else {
        item.status = 'failed';
        item.stage = '失败';
        item.error = e?.message || String(e);
        item.durationMs = Date.now() - t0;
        item.finishedAt = Date.now();
      }
    }
    this.emitProgress();
  }
}

/* ---------------- 平台适配文案模板 ---------------- */
export const PLATFORM_SPEC: Record<BatchItem['platform'], {
  name: string;
  /** 视频比例 */
  ratio: string;
  /** 标题长度上限 */
  titleMax: number;
  /** 标签数量 */
  tagCount: number;
  /** 文案风格提示 */
  style: string;
}> = {
  douyin: {
    name: '抖音', ratio: '9:16', titleMax: 30, tagCount: 5,
    style: '开头 3 秒必须有强钩子；口语化、短句、有节奏感；避免书面语；结尾引导点赞关注。',
  },
  xiaohongshu: {
    name: '小红书', ratio: '3:4', titleMax: 20, tagCount: 10,
    style: '标题要有情绪点和 emoji；正文像闺蜜分享，分点写；结尾提问引导评论区互动。',
  },
  bilibili: {
    name: 'B站', ratio: '16:9', titleMax: 40, tagCount: 10,
    style: '开头可自嘲或抛问题；内容偏硬核、有信息增量；结尾提三连。',
  },
  youtube: {
    name: 'YouTube', ratio: '16:9', titleMax: 70, tagCount: 12,
    style: '英文优先；前 30 秒说清视频价值；内容结构化，适配章节；结尾引导订阅。',
  },
  wechat: {
    name: '公众号/视频号', ratio: '9:16', titleMax: 30, tagCount: 5,
    style: '中文书面语但不失传播性；开头给结论；适合中长视频，配字幕更友好。',
  },
  general: {
    name: '通用', ratio: '9:16', titleMax: 40, tagCount: 6,
    style: '通用风格，兼顾各大平台。',
  },
};

/* ---------------- 批量脚本生成提示 ---------------- */
export function buildBatchScriptPrompt(topic: string, platform: string, req?: string): string {
  const spec = PLATFORM_SPEC[platform as BatchItem['platform']] || PLATFORM_SPEC.general;
  return `/no_think
你是短视频内容策划。为【${spec.name}】平台创作一个短视频脚本。

【平台风格要求】${spec.style}
【视频比例】${spec.ratio}（横屏/竖屏请在画面描述中体现）
【标题长度】不超过 ${spec.titleMax} 字
【标签数量】${spec.tagCount} 个

【主题】${topic}
${req ? `【额外要求】${req}` : ''}

请严格按以下 JSON 输出（不要输出任何解释文字）：
{
  "title": "标题",
  "hook": "前3秒钩子",
  "scenes": [
    { "duration": 5, "visual": "画面描述（具体可视化）", "caption": "字幕(≤15字)", "narration": "配音稿" }
  ],
  "tags": ["标签1","标签2"],
  "coverText": "封面大字（≤12字）"
}

要求：
- 5-8 个场景，总时长 ${'20-45'} 秒
- 每个场景 duration 3-8 秒
- narration 是完整口播稿，口语化
- visual 要具体到能画出来的画面`;
}
