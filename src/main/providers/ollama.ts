/* ============================================================================
 * main/providers/ollama.ts —— 本地 Ollama Provider
 * ----------------------------------------------------------------------------
 * 为什么优先用本地：
 *   · 完全免费、无限量、不限速、离线可用、代码不出本机
 *   · 8GB 内存 + 4 核无 GPU 的可行档位：
 *       qwen3:8b  (Q4_K_M ≈ 5.2GB) ← 推荐，速度约 8-12 tok/s
 *       qwen3:4b  (Q4_K_M ≈ 2.6GB) ← 轻量机兜底，约 15-25 tok/s
 *       qwen2.5-coder:7b            ← 纯代码任务略强
 *   · 无 GPU 时用 CPU 推理，llama.cpp 的 Q4_K_M 量化在 4 核上仍可交互
 * ========================================================================== */
import { Provider, ChatRequest, ChatResponse, fetchWithTimeout, errText, parseSSE } from './types';
import { ModelInfo } from '../../shared/types';
import { cpus } from 'node:os';
import { detectHardware } from '../hardware';

const DEFAULT_BASE = 'http://127.0.0.1:11434';

/** 硬件建议是否已应用（避免每次请求都重新探 GPU） */
let appliedHardware = false;

/**
 * 把 Ollama / 本地模型的英文错误翻译成中文，并给出可操作建议。
 * 这样即使模型服务报错，用户也能看懂并自行恢复，而不是面对一堆英文 JSON。
 */
export function translateEngineError(raw: string): string {
  const s = (raw || '').toLowerCase();

  // 1) 内存 / 显存不足（本地最常见的 OOM）
  if (
    s.includes('out-of-memory') ||
    s.includes('failed to allocate') ||
    s.includes('failed to initialize the context') ||
    s.includes('cannot allocate') ||
    s.includes('buffer of size') ||
    s.includes('ggml_backend') ||
    s.includes('more system memory') ||
    s.includes('requires more system')
  ) {
    /* ★实时内存诊断（2026-10-26）：报错时直接告诉用户当前可用内存和能跑什么规格，
       不再让用户对着固定文案猜。 */
    const os = require('node:os');
    const freeGb = os.freemem() / 1073741824;
    const tier = freeGb < 5
      ? '当前只能跑 ≤4b 的小模型（如 qwen3:4b）'
      : freeGb < 8
        ? '当前最多能跑 7b~9b（勉强），建议 4b 更稳'
        : '当前可以尝试 9b 及以下';
    return [
      '⚠️ 本地模型加载失败：内存不足。',
      `当前可用内存 ${freeGb.toFixed(1)} GB（总内存 16 GB）——${tier}。`,
      '本次加载的模型需要更多内存，无法完成。',
      '建议：',
      '  ① 关闭浏览器/多余窗口腾出内存后重试（每关 1GB 约多跑 1.5b 规格）；',
      '  ② 或直接切换小模型：qwen3:4b（约需 3.5GB，当前够用）；',
      '  ③ 14b 这类大模型在本机（15.7GB 总内存）基本无缘，除非关闭绝大部分程序。',
    ].join('\n');
  }

  // 2) 模型未安装
  if (s.includes('not found') && (s.includes('model') || s.includes('blob'))) {
    return [
      '⚠️ 指定的模型没有安装到本地 Ollama。',
      '建议：打开左下角「模型库」点击一键下载对应模型，或在对话底部把当前模型切换为已安装的小模型。',
    ].join('\n');
  }

  // 3) 连接不上 Ollama（服务没启动）
  if (
    s.includes('fetch failed') ||
    s.includes('econnrefused') ||
    s.includes('connection refused') ||
    s.includes('network') ||
    (s.includes('connect') && s.includes('fail'))
  ) {
    return [
      '⚠️ 无法连接本地 Ollama 服务（127.0.0.1:11434）。',
      '建议：① 点击左侧「启动 Ollama」按钮；② 确认 Ollama 已安装并正在运行。',
    ].join('\n');
  }

  // 4) 请求被用户取消
  if (s.includes('abort') || s.includes('已取消') || s.includes('cancel')) {
    return '⚠️ 请求已取消。';
  }

  // 5) 兜底：保留精简后的原文 + 通用建议
  const short = (raw || '').replace(/\s+/g, ' ').slice(0, 300);
  return [
    '⚠️ 本地模型调用出错：',
    short,
    '',
    '若持续失败，请尝试：① 点击左侧「重启 Ollama」；② 切换更小的模型；③ 关闭占用内存的程序。',
  ].join('\n');
}

/* ★上下文长度按模型规模自适应（2026-10-26）：
   小模型(≤4b)权重小，给 8192 保完整提示词+手册；
   大模型(≥7b)权重大，KV 缓存降到 4096 省内存，优先保证加载成功不 OOM。 */
export function ctxForModel(model: string): number {
  const m = (model || '').toLowerCase();
  const big = /(^|[:\-_])([6-9]|1[0-9]|2[0-9]|3[0-2])b([:\-_ ]|$)/.test(m) && !/0\.[5-9]b/.test(m);
  return big ? 4096 : 8192;
}

export class OllamaProvider implements Provider {
  kind = 'ollama' as const;
  name = 'Ollama 本地';
  baseUrl: string;
  model: string;

  /**
   * 推理线程数。默认用满可用核心（有 GPU 时取一半辅助、无 GPU 全核），
   * 由 detectHardware() 自适应得出。可在引擎设置里手动覆盖为 0=用满/具体数值。
   */
  numThread = Math.max(1, Math.min(4, Math.floor(cpus().length / 2)));

  /**
   * GPU 层数。检测到 GPU 时设为拉满（由 Ollama 自动装显存），无 GPU 时不传（纯 CPU）。
   * 通过 adjustToHardware() 自适应。
   */
  numGPU = -1;

  /**
   * 根据硬件自适应调整线程/GPU 参数：
   *   · 有 GPU → num_thread=核数一半(封顶8) + num_gpu 拉满
   *   · 无 GPU → num_thread=全部核心 + num_gpu 忽略（纯 CPU）
   * 只在首次调用时探测一次并应用，避免每次请求都执行耗时的 nvidia-smi。
   */
  async adjustToHardware(): Promise<void> {
    if (appliedHardware) return;
    try {
      const hw = await detectHardware();
      if (hw.hasGPU) {
        this.numThread = hw.suggestThreads; // 一半核心辅助
        this.numGPU = hw.suggestNumGPU;        // 999 → 全交 GPU
      } else {
        this.numThread = hw.suggestThreads;    // 全部核心
        this.numGPU = -1;                       // 纯 CPU
      }
      appliedHardware = true;
    } catch { /* 探测失败保持默认 */ }
  }

  constructor(baseUrl = DEFAULT_BASE, model = 'qwen3:8b') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.model = model;
  }

  async probe(): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 5000);
      if (!r.ok) return { ok: false, message: `HTTP ${r.status}（Ollama 是否已启动？）` };
      const j: any = await r.json();
      const n = (j.models || []).length;
      return {
        ok: true,
        message: `已连接 · 本地模型 ${n} 个`,
        latencyMs: Date.now() - t0,
      };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const r = await fetchWithTimeout(`${this.baseUrl}/api/tags`, {}, 8000);
      if (!r.ok) return [];
      const j: any = await r.json();
      return (j.models || []).map((m: any) => {
        const sizeGB = m.size ? (m.size / 1024 / 1024 / 1024).toFixed(1) + 'GB' : undefined;
        const q = m.details?.quantization_level;
        return {
          id: m.name,
          provider: 'ollama' as const,
          name: m.name,
          size: sizeGB,
          quantization: q,
          contextLength: 32768,
          local: true,
          free: true,
          downloaded: true,
        };
      });
    } catch (e) {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = Date.now();
    try {
      await this.adjustToHardware();
      // Ollama 的 /api/chat 支持 stream:true，格式与 OpenAI SSE 接近但字段不同，
      // 这里按 Ollama 原生格式解析
      const body: any = {
        model: this.model,
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          temperature: req.temperature ?? 0.3,
          num_predict: req.maxTokens ?? 4096,
          /* ★repeat_penalty 1.15：本地小模型低温度下极易复读，
             无惩罚时 4096 token 全是循环垃圾（2026-10-26 实测根因）。 */
          repeat_penalty: 1.15,
          /* ★num_ctx 不在此定死：见下方 OOM 自愈循环，按模型规格起始、失败自动降级 */
          ...(this.numThread > 0 ? { num_thread: this.numThread } : {}),
          /* ★GPU 自适应：检测到显卡就让 Ollama 尽量装显存（num_gpu 拉满）；
           *   纯 CPU 机不传此字段，避免 Ollama 报错。 */
          ...(this.numGPU > 0 ? { num_gpu: this.numGPU } : {}),
        },
      };
      /* ★think 默认关闭：Qwen3 开启思考会显著变慢且内容在 thinking 字段。
         用户显式要求思考时才开（此时把 thinking 也拼到内容里）。 */
      body.think = req.thinking === true;
      /* ★keep_alive 3 分钟：空闲即从内存/CPU 卸载模型。
         默认 5 分钟会在关闭程序后仍让 ollama_llama_server.exe 占着核心。 */
      body.keep_alive = 180;

      /* ★熔断器：检测到复读循环时中断流（转发调用方停止信号 + 自主熔断） */
      const ctrl = new AbortController();
      if (req.signal) {
        if (req.signal.aborted) ctrl.abort();
        else req.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
      }
      /* ★OOM 自愈（2026-10-26 实测：4.6GB 可用内存下 4b@8192 临界失败、4096 成功）：
         加载报内存不足时自动降 num_ctx 重试 8192→4096→2048，能开就一定开得起来。 */
      const isOOM = (t: string) =>
        /out-of-memory|failed to allocate|cannot allocate|buffer of size|ggml_backend|more system memory|requires more system/i.test(t);
      let ctxUsed = ctxForModel(this.model);
      let res: any = null;
      for (;;) {
        body.options.num_ctx = ctxUsed;
        res = await fetchWithTimeout(
          `${this.baseUrl}/api/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          },
          600000
        );
        if (res.ok) break;
        const t = await res.text().catch(() => '');
        if (isOOM(t) && ctxUsed > 2048) {
          ctxUsed = ctxUsed > 4096 ? 4096 : 2048;
          continue;
        }
        return {
          content: '',
          model: this.model,
          provider: 'ollama',
          durationMs: Date.now() - t0,
          error: translateEngineError(`HTTP ${res.status}: ${t}`),
        };
      }

      let content = '';
      let thinking = '';
      /* ★复读检测：取尾部最近40字符片段，在尾部800字符内出现≥4次判定为循环 */
      const isLoopText = (text: string): boolean => {
        const tail = text.slice(-800);
        const seg = tail.slice(-40).replace(/\s+/g, ' ').trim();
        if (seg.length < 12) return false;
        let count = 0;
        let idx = tail.indexOf(seg);
        while (idx !== -1) {
          count++;
          if (count >= 4) return true;
          idx = tail.indexOf(seg, idx + 1);
        }
        return false;
      };
      let loopStopped = false;
      for await (const data of parseSSE(res, req.signal)) {
        try {
          const j = JSON.parse(data);
          /* ★Qwen3 默认开启「思考模式」：
           *   推理内容在 message.thinking，最终答案在 message.content。
           *   只取 content 会得到空字符串（表现为"模型没回复"）。 */
          const thinkPiece = j.message?.thinking || '';
          const piece = j.message?.content || j.response || '';
          if (thinkPiece) {
            thinking += thinkPiece;
            /* 思考增量实时推送（界面可折叠展示，绝不丢弃） */
            req.onThinking?.(thinkPiece);
          }
          if (piece) {
            content += piece;
            req.onToken?.(piece);
            /* ★循环熔断：重复片段达到阈值立即中止，不再烧几分钟 token */
            if (isLoopText(content)) {
              loopStopped = true;
              try { ctrl.abort(); } catch (e) { }
              break;
            }
          }
          if (j.done) {
            /* ★只吐思考没给答案时，把思考作为内容返回（杜绝永远空白的气泡） */
            if (!content && thinking) content = thinking;
            return {
              content,
              model: this.model,
              provider: 'ollama',
              usage: {
                promptTokens: j.prompt_eval_count,
                completionTokens: j.eval_count,
              },
              durationMs: Date.now() - t0,
            };
          }
        } catch (e) {
          /* 忽略非 JSON 行 */
        }
      }
      return {
        content: loopStopped
          ? content + '\n\n[已自动截断：检测到模型重复输出循环。建议新建会话（旧对话可能被污染）或换个问法重试]'
          : content,
        model: this.model,
        provider: 'ollama',
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return {
        content: '',
        model: this.model,
        provider: 'ollama',
        durationMs: Date.now() - t0,
        error: translateEngineError(errText(e)),
      };
    }
  }
}
