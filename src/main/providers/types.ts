/* ============================================================================
 * main/providers/types.ts —— Provider 抽象
 * ----------------------------------------------------------------------------
 * 所有模型来源统一成 OpenAI 风格的 chat 接口，内部屏蔽各家差异：
 *   · Ollama      —— 本地免费无限量，8G 机器用 qwen3:8b / qwen3:4b
 *   · OpenRouter  —— 云端免费层，模型 id 带 :free 后缀，50 次/天（充值后 1000）
 *   · Gemini      —— Google AI Studio 免费层，长上下文
 *   · Groq        —— 免费层，速度极快（LPU）
 *   · Custom      —— 任何 OpenAI 兼容端点（含自建 llama.cpp / vLLM）
 * ========================================================================== */
import { ProviderKind, ChatMessage, ModelInfo } from '../../shared/types';

export interface ChatRequest {
  messages: ChatMessage[];
  /** 流式回调，每收到一段增量调用一次 */
  onToken?: (chunk: string) => void;
  /** 思考过程回调（Qwen3 等推理模型的 thinking 增量，实时推送） */
  onThinking?: (chunk: string) => void;
  /** 温度 */
  temperature?: number;
  maxTokens?: number;
  /** 是否启用思考模式（部分模型支持） */
  thinking?: boolean;
  signal?: AbortSignal;
}

export interface ChatResponse {
  content: string;
  model: string;
  provider: ProviderKind;
  usage?: { promptTokens?: number; completionTokens?: number };
  durationMs: number;
  error?: string;
}

export interface Provider {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  model: string;
  apiKey?: string;

  /** 探测是否可用（连接测试） */
  probe(): Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  /** 列出该来源可用的模型 */
  listModels(): Promise<ModelInfo[]>;
  /** 发起对话 */
  chat(req: ChatRequest): Promise<ChatResponse>;
}

/* ---------------- 通用工具 ---------------- */

/** 带超时的 fetch */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 120000
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  // 外部 signal 与超时 signal 合并
  if (init.signal) {
    init.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 解析流式响应，返回逐条数据文本。
 *
 * ★兼容两种格式（实测踩坑）：
 *   ① 标准 SSE（OpenAI / Gemini / Groq）：`data: {...}\n\n`
 *   ② Ollama 原生 NDJSON：每行一个 JSON，用**单个 \n** 分隔，**没有 data: 前缀**
 *      → 只按标准 SSE 解析会导致 Ollama 一个 token 都收不到（表现为"模型没回复"）
 */
export async function* parseSSE(
  response: Response,
  signal?: AbortSignal
): AsyncGenerator<string> {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    if (signal?.aborted) break;
    let done = false;
    try {
      const { value, done: d } = await reader.read();
      done = d;
      if (value) buffer += decoder.decode(value, { stream: true });
    } catch (e) {
      break;
    }
    if (done) {
      // 收尾：把残留 buffer 也吐出来（可能是最后一条 NDJSON）
      for (const line of buffer.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        const data = t.startsWith('data:') ? t.slice(5).trim() : t;
        if (!data || data === '[DONE]') continue;
        yield data;
      }
      break;
    }

    /* ① 标准 SSE：以空行（\n\n）分隔事件 */
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of chunk.split('\n')) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        yield data;
      }
    }

    /* ② NDJSON（Ollama）：单行一个 JSON，用单 \n 分隔 */
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith('data:')) {
        const d = line.slice(5).trim();
        if (d && d !== '[DONE]') yield d;
      } else if (line.startsWith('{')) {
        // 裸 JSON 行（Ollama 格式）
        yield line;
      }
    }
  }
}

/** 统一的错误提取 */
export function errText(e: any): string {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e.name === 'AbortError') return '请求已取消';
  return e.message || String(e);
}
