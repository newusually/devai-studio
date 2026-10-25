/* ============================================================================
 * main/providers/openai-compatible.ts —— OpenAI 兼容协议 Provider
 * ----------------------------------------------------------------------------
 * 覆盖：OpenRouter（:free 模型）、Groq、任何自建 OpenAI 兼容端点（vLLM / llama.cpp / LM Studio）
 *
 * 免费额度现状（2026-10 核实）：
 *   · OpenRouter  : 模型 id 带 ":free" 后缀 → $0/token
 *                   限额 20 次/分钟、50 次/天（买过一次 $10 额度后永久升到 1000 次/天）
 *                   有 openrouter/free 自动路由（自动挑当前最强免费模型）
 *   · Groq        : LPU 推理，Llama 3.3 70B 约 320 tok/s，免费层 30 RPM / 1000 次/天
 *   · 自建端点     : 完全免费无限量，取决于本机算力
 * ========================================================================== */
import { Provider, ChatRequest, ChatResponse, fetchWithTimeout, errText, parseSSE } from './types';
import { ProviderKind, ModelInfo } from '../../shared/types';

export interface OpenAICompatOptions {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  /** 模型 id 是否需要追加 ":free" */
  freeSuffix?: boolean;
  /** 该来源的免费额度描述 */
  freeQuota?: string;
  /** 列出模型时的额外过滤 */
  modelFilter?: (m: any) => boolean;
}

export class OpenAICompatProvider implements Provider {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;
  freeSuffix: boolean;
  freeQuota?: string;
  modelFilter?: (m: any) => boolean;

  constructor(o: OpenAICompatOptions) {
    this.kind = o.kind;
    this.name = o.name;
    this.baseUrl = o.baseUrl.replace(/\/$/, '');
    this.model = o.model;
    this.apiKey = o.apiKey;
    this.freeSuffix = o.freeSuffix ?? false;
    this.freeQuota = o.freeQuota;
    this.modelFilter = o.modelFilter;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    // OpenRouter 推荐带上来源标识，便于在 dashboard 里区分
    if (this.kind === 'openrouter') {
      h['HTTP-Referer'] = 'https://github.com/yourname/devai-studio';
      h['X-Title'] = 'DevAI Studio';
    }
    return h;
  }

  async probe(): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    const t0 = Date.now();
    try {
      if (this.apiKey) {
        const r = await fetchWithTimeout(
          `${this.baseUrl}/models`,
          { headers: this.headers() },
          10000
        );
        if (!r.ok) return { ok: false, message: `HTTP ${r.status}（API Key 可能无效）` };
        const j: any = await r.json();
        const n = (j.data || []).length;
        return { ok: true, message: `已连接 · 可用模型 ${n} 个`, latencyMs: Date.now() - t0 };
      }
      return { ok: true, message: '未配置 API Key（该端点可能无需鉴权）' };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const r = await fetchWithTimeout(
        `${this.baseUrl}/models`,
        { headers: this.headers() },
        15000
      );
      if (!r.ok) return [];
      const j: any = await r.json();
      const arr = (j.data || []).filter((m: any) => (this.modelFilter ? this.modelFilter(m) : true));
      return arr.map((m: any) => {
        const id = m.id || m.name || '';
        const isFree = id.endsWith(':free') || id.includes('/free');
        const ctx = m.context_length || m.context_len || m.max_context_length;
        return {
          id,
          provider: this.kind,
          name: id.split('/').pop() || id,
          contextLength: ctx,
          local: false,
          free: isFree || this.kind === 'groq',
          downloaded: false,
        };
      });
    } catch (e) {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = Date.now();
    const modelId = this.freeSuffix && !this.model.endsWith(':free')
      ? `${this.model}:free`
      : this.model;

    try {
      const body: any = {
        model: modelId,
        messages: req.messages.map(m => ({
          role: m.role,
          content: m.content,
        })),
        stream: true,
        temperature: req.temperature ?? 0.3,
        max_tokens: req.maxTokens ?? 4096,
      };

      const res = await fetchWithTimeout(
        `${this.baseUrl}/chat/completions`,
        {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(body),
          signal: req.signal,
        },
        600000
      );

      if (!res.ok) {
        const t = await res.text().catch(() => '');
        let msg = `HTTP ${res.status}: ${t.slice(0, 300)}`;
        try {
          const ej = JSON.parse(t);
          if (ej.error?.message) msg = ej.error.message;
        } catch (e) { /* 非 JSON */ }
        return {
          content: '',
          model: modelId,
          provider: this.kind,
          durationMs: Date.now() - t0,
          error: msg,
        };
      }

      let content = '';
      let promptTokens = 0;
      let completionTokens = 0;

      for await (const data of parseSSE(res, req.signal)) {
        try {
          const j = JSON.parse(data);
          const piece = j.choices?.[0]?.delta?.content ?? '';
          if (piece) {
            content += piece;
            req.onToken?.(piece);
          }
          if (j.usage) {
            promptTokens = j.usage.prompt_tokens || promptTokens;
            completionTokens = j.usage.completion_tokens || completionTokens;
          }
          if (j.choices?.[0]?.finish_reason) {
            return {
              content,
              model: modelId,
              provider: this.kind,
              usage: { promptTokens, completionTokens },
              durationMs: Date.now() - t0,
            };
          }
        } catch (e) { /* 忽略 */ }
      }
      return {
        content,
        model: modelId,
        provider: this.kind,
        usage: { promptTokens, completionTokens },
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return {
        content: '',
        model: modelId,
        provider: this.kind,
        durationMs: Date.now() - t0,
        error: errText(e),
      };
    }
  }
}
