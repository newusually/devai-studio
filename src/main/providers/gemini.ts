/* ============================================================================
 * main/providers/gemini.ts —— Google Gemini 免费层 Provider
 * ----------------------------------------------------------------------------
 * 免费额度（2026-10 核实）：
 *   · Google AI Studio：Gemini Flash 系列免费层，约 1500 次/天（每天重置）
 *   · 上下文可达 1M tokens → 处理超大代码仓库比本地模型强得多
 *   · 缺点：部分协议非 OpenAI 兼容，需单独实现
 *
 * 免费模型的取舍：
 *   gemini-2.5-flash      —— 免费层主力，速度快、上下文长
 *   gemini-2.5-flash-lite —— 更省配额，批量分析用
 *   gemini-2.5-pro        —— 免费层额度极紧，仅作为可选
 * ========================================================================== */
import { Provider, ChatRequest, ChatResponse, fetchWithTimeout, errText } from './types';
import { ModelInfo } from '../../shared/types';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export class GeminiProvider implements Provider {
  kind = 'gemini' as const;
  name = 'Google Gemini 免费层';
  baseUrl: string;
  model: string;
  apiKey?: string;

  constructor(apiKey = '', model = 'gemini-2.5-flash', baseUrl = DEFAULT_BASE) {
    this.apiKey = apiKey;
    this.model = model;
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  async probe(): Promise<{ ok: boolean; message: string; latencyMs?: number }> {
    if (!this.apiKey) return { ok: false, message: '未配置 API Key（aistudio.google.com 免费申请）' };
    const t0 = Date.now();
    try {
      const r = await fetchWithTimeout(
        `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`,
        {},
        10000
      );
      if (!r.ok) return { ok: false, message: `HTTP ${r.status}（API Key 无效？）` };
      const j: any = await r.json();
      const n = (j.models || []).length;
      return { ok: true, message: `已连接 · 可用模型 ${n} 个`, latencyMs: Date.now() - t0 };
    } catch (e) {
      return { ok: false, message: errText(e) };
    }
  }

  async listModels(): Promise<ModelInfo[]> {
    if (!this.apiKey) return [];
    try {
      const r = await fetchWithTimeout(
        `${this.baseUrl}/models?key=${encodeURIComponent(this.apiKey)}`,
        {},
        15000
      );
      if (!r.ok) return [];
      const j: any = await r.json();
      return (j.models || [])
        .filter((m: any) => m.name?.includes('generateContent'))
        .map((m: any) => {
          const id = m.name.split('/').pop();
          return {
            id,
            provider: 'gemini' as const,
            name: id,
            contextLength: m.inputTokenLimit,
            local: false,
            free: true,
            downloaded: false,
          };
        });
    } catch (e) {
      return [];
    }
  }

  async chat(req: ChatRequest): Promise<ChatResponse> {
    const t0 = Date.now();
    if (!this.apiKey) {
      return {
        content: '',
        model: this.model,
        provider: 'gemini',
        durationMs: Date.now() - t0,
        error: '未配置 Gemini API Key',
      };
    }

    try {
      // Gemini 用 contents[] 而不是 messages[]
      const contents = req.messages
        .filter(m => m.role !== 'system')
        .map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

      const system = req.messages.find(m => m.role === 'system')?.content;

      const body: any = {
        contents,
        generationConfig: {
          temperature: req.temperature ?? 0.3,
          maxOutputTokens: req.maxTokens ?? 4096,
        },
      };
      if (system) body.systemInstruction = { parts: [{ text: system }] };

      const url = `${this.baseUrl}/models/${this.model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`;

      const res = await fetchWithTimeout(
        url,
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
        let msg = `HTTP ${res.status}: ${t.slice(0, 300)}`;
        try {
          const ej = JSON.parse(t);
          if (ej.error?.message) msg = ej.error.message;
        } catch (e) { /* 非 JSON */ }
        return {
          content: '',
          model: this.model,
          provider: 'gemini',
          durationMs: Date.now() - t0,
          error: msg,
        };
      }

      let content = '';
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buf = '';
        for (;;) {
          if (req.signal?.aborted) break;
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            for (const line of chunk.split('\n')) {
              const t = line.trim();
              if (!t.startsWith('data:')) continue;
              const d = t.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              try {
                const j = JSON.parse(d);
                const piece = j.candidates?.[0]?.content?.parts?.map((p: any) => p.text || '').join('') || '';
                if (piece) {
                  content += piece;
                  req.onToken?.(piece);
                }
              } catch (e) { /* 忽略 */ }
            }
          }
        }
      }

      return {
        content,
        model: this.model,
        provider: 'gemini',
        durationMs: Date.now() - t0,
      };
    } catch (e) {
      return {
        content: '',
        model: this.model,
        provider: 'gemini',
        durationMs: Date.now() - t0,
        error: errText(e),
      };
    }
  }
}
