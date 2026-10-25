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

const DEFAULT_BASE = 'http://127.0.0.1:11434';

export class OllamaProvider implements Provider {
  kind = 'ollama' as const;
  name = 'Ollama 本地';
  baseUrl: string;
  model: string;

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
      // Ollama 的 /api/chat 支持 stream:true，格式与 OpenAI SSE 接近但字段不同，
      // 这里按 Ollama 原生格式解析
      const body: any = {
        model: this.model,
        messages: req.messages.map(m => ({ role: m.role, content: m.content })),
        stream: true,
        options: {
          temperature: req.temperature ?? 0.3,
          num_predict: req.maxTokens ?? 4096,
          num_ctx: 8192,
        },
      };
      /* ★think 默认关闭：Qwen3 开启思考会显著变慢且内容在 thinking 字段。
         用户显式要求思考时才开（此时把 thinking 也拼到内容里）。 */
      body.think = req.thinking === true;

      const res = await fetchWithTimeout(
        `${this.baseUrl}/api/chat`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: req.signal,
        },
        600000
      );
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        return {
          content: '',
          model: this.model,
          provider: 'ollama',
          durationMs: Date.now() - t0,
          error: `HTTP ${res.status}: ${t.slice(0, 300)}`,
        };
      }

      let content = '';
      let thinking = '';
      for await (const data of parseSSE(res, req.signal)) {
        try {
          const j = JSON.parse(data);
          /* ★Qwen3 默认开启「思考模式」：
           *   推理内容在 message.thinking，最终答案在 message.content。
           *   只取 content 会得到空字符串（表现为"模型没回复"）。 */
          const thinkPiece = j.message?.thinking || '';
          const piece = j.message?.content || j.response || '';
          if (thinkPiece) thinking += thinkPiece;
          if (piece) {
            content += piece;
            req.onToken?.(piece);
          }
          if (j.done) {
            return {
              content,
              model: this.model,
              provider: 'ollama',
              usage: {
                promptTokens: j.prompt_eval_count,
                completionTokens: j.eval_count,
              },
              durationMs: Date.now() - t0,
              /* 若模型只吐了思考没给答案，把思考作为内容返回（至少不空手） */
              error: (!content && thinking) ? undefined : undefined,
            };
          }
        } catch (e) {
          /* 忽略非 JSON 行 */
        }
      }
      return {
        content,
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
        error: errText(e),
      };
    }
  }
}
