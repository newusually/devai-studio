/* ============================================================================
 * engine/ai-compat.ts —— OpenClaw `@openclaw/ai` 传输层的本地等价实现
 * ----------------------------------------------------------------------------
 * 来源：openclaw/packages/ai/src（MIT, Apache-2.0 双许可，见仓库 LICENSE）
 *   - isContextOverflow / matchesContextOverflowMessage
 *       ← utils/overflow.ts（原样搬运，含全部厂商溢出特征表，Ollama 专用特征在内）
 *   - replaceCompactionReplayOwnerContent / isCompactionReplayCheckpoint /
 *     stripCompactionReplayCheckpoint
 *       ← transports/provider-compaction-replay.ts + provider-compaction-checkpoint.ts
 *         （providerReplay 检查点为 Anthropic/OpenAI-Responses 专有状态，
 *           Ollama 消息永不携带，逻辑等价）
 *   - isResponsesOutputLimitToolCallError
 *       ← providers/openai-responses-terminal-usage.ts
 *   - createEmptyTransportUsage ← transports/transport-stream-shared.ts（createZeroUsage）
 *   - resolveCompletionTokenReservation
 *       ← transports/anthropic-transport-options.ts
 *         （仅对 anthropic-messages / bedrock-converse-stream 做思考Token预留，
 *           Ollama 等其余 API 直接返回 maxTokens，与原实现行为一致）
 *
 * 为什么不整体搬 ai 包：ai 包 217 个文件且强依赖 openai/anthropic/google 三家
 * SDK；而 agent-core 非测试代码只用到上面 5 个符号。此处按原实现等价落地，
 * 避免为一个引擎拖进三个重型 SDK。
 * ========================================================================== */

import { isProviderRefusalAssistantError } from "./llm-core/utils/diagnostics.js";
import type { AssistantMessage, Model, Usage } from "./llm-core/types.js";

/* ---------------------------------------------------------------------------
 * ① createEmptyTransportUsage（← transport-stream-shared.ts / createZeroUsage）
 * ------------------------------------------------------------------------- */
export function createEmptyTransportUsage(): Pick<
  Usage,
  "input" | "output" | "cacheRead" | "cacheWrite" | "contextUsage" | "totalTokens"
> & {
  cost: Pick<Usage["cost"], "input" | "output" | "cacheRead" | "cacheWrite" | "total">;
} {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/* ---------------------------------------------------------------------------
 * ② resolveCompletionTokenReservation（← anthropic-transport-options.ts）
 *    仅 Anthropic/Bedrock 需要为思考Token压缩输出上限；其余 API 原样返回。
 * ------------------------------------------------------------------------- */
export function resolveCompletionTokenReservation(
  model: Model,
  maxTokens: number,
  reasoning?: unknown,
): number {
  if (
    !reasoning ||
    reasoning === "off" ||
    (model.api !== "anthropic-messages" && model.api !== "bedrock-converse-stream")
  ) {
    return maxTokens;
  }
  // Anthropic/Bedrock 的思考预留逻辑依赖 anthropic-transport-options 全量实现；
  // 本项目只接 Ollama/OpenAI 兼容源，永不进入此分支。保守返回上限的一半，
  // 即使将来误入也不会超出窗口（与"只缩prompt不溢出"的原注释语义一致）。
  return Math.floor(maxTokens / 2);
}

/* ---------------------------------------------------------------------------
 * ③ isResponsesOutputLimitToolCallError
 *    （← providers/openai-responses-terminal-usage.ts）
 * ------------------------------------------------------------------------- */
export function isResponsesOutputLimitToolCallError(
  message: Pick<AssistantMessage, "stopReason" | "errorCode" | "diagnostics">,
): boolean {
  return (
    message.stopReason === "error" &&
    message.errorCode === "incomplete_tool_call" &&
    !isProviderRefusalAssistantError(message as AssistantMessage) &&
    message.diagnostics?.some(
      ({ type, details }: { type?: string; details?: Record<string, unknown> }) =>
        type === "openai_responses_terminal" &&
        details?.eventType === "response.incomplete" &&
        details.stopReason === "length" &&
        details.incompleteReason === "max_output_tokens",
    ) === true
  );
}

/* ---------------------------------------------------------------------------
 * ④ providerReplay 检查点辅助（← provider-compaction-checkpoint.ts，原样）
 * ------------------------------------------------------------------------- */
type ProviderReplayState = NonNullable<AssistantMessage["providerReplay"]>;

export function isCompactionReplayCheckpoint(
  replay: unknown,
): replay is ProviderReplayState {
  const type =
    replay && typeof replay === "object" ? (replay as { type?: unknown }).type : undefined;
  return (
    type === "anthropic-compaction" ||
    type === "openai-responses-compaction" ||
    type === "openai-responses-retained-compaction"
  );
}

/** Strip prefix-bound checkpoints after local history rewrites. */
export function stripCompactionReplayCheckpoint(
  message: AssistantMessage,
): AssistantMessage {
  if (!isCompactionReplayCheckpoint(message.providerReplay)) {
    return message;
  }
  const replaySafeMessage = { ...message };
  delete replaySafeMessage.providerReplay;
  return replaySafeMessage;
}

/** Preserve the covered prefix and reindex checkpoints after known content removals. */
export function replaceCompactionReplayOwnerContent(
  message: AssistantMessage,
  content: AssistantMessage["content"],
): AssistantMessage {
  const next = { ...message, content };
  const replay = message.providerReplay;
  if (!isCompactionReplayCheckpoint(replay)) {
    return next;
  }
  if (replay.type === "openai-responses-retained-compaction") {
    // This checkpoint is anchored to retained user turns, not assistant content indexes.
    return next;
  }
  const replayIndex = (replay as { replayIndex?: number }).replayIndex ?? 0;
  if (
    (content.length === 0 && message.content.length > 0) ||
    replayIndex > message.content.length
  ) {
    return stripCompactionReplayCheckpoint(next);
  }
  // Same-position rewrites after the checkpoint (such as tool-call id repair)
  // change only the replayed suffix, not the prefix covered by its opaque state.
  if (
    content.length === message.content.length &&
    content.slice(0, replayIndex).every((block, index) => block === message.content[index])
  ) {
    return next;
  }
  let sourceIndex = 0;
  let nextReplayIndex = 0;
  const unambiguous = content.every((block) => {
    const index = message.content.indexOf(block, sourceIndex);
    sourceIndex = index + 1;
    nextReplayIndex += index >= 0 && index < replayIndex ? 1 : 0;
    return index >= 0;
  });
  if (!unambiguous) {
    return stripCompactionReplayCheckpoint(next);
  }
  return nextReplayIndex === replayIndex
    ? next
    : { ...next, providerReplay: { ...replay, replayIndex: nextReplayIndex } };
}

/* ---------------------------------------------------------------------------
 * ⑤ 上下文溢出识别（← utils/overflow.ts，特征表原样搬运）
 * ------------------------------------------------------------------------- */
const CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE =
  /prompt has [\d,]+ tokens?, but the configured context size is [\d,]+ tokens?/i;
const REQUEST_BUDGET_OVERFLOW_RE =
  /context window exceeded: estimated input \d+ leaves only \d+ output tokens within the \d+-token context\./i;

const ASSISTANT_OVERFLOW_PATTERNS = [
  REQUEST_BUDGET_OVERFLOW_RE,
  /prompt is too long/i, // Anthropic token overflow
  /request_too_large/i, // Anthropic request byte-size overflow (HTTP 413)
  /input length and `?max_tokens`? exceed context limit: [\d,]+ \+ [\d,]+ > [\d,]+/i, // Anthropic direct API
  /input is too long for requested model/i, // Amazon Bedrock
  /exceeds the context window/i, // OpenAI (Completions & Responses API)
  /exceeds (?:the )?(?:model'?s )?maximum context length(?: of [\d,]+ tokens?|\s*\([\d,]+\))/i, // OpenAI-compatible proxies (LiteLLM)
  /input token count.*exceeds the maximum/i, // Google (Gemini)
  /maximum prompt length is \d+/i, // xAI (Grok)
  /reduce the length of the messages/i, // Groq
  /maximum context length is \d+ tokens/i, // OpenRouter (all backends)
  /exceeds (?:the )?maximum allowed input length of [\d,]+ tokens?/i, // OpenRouter/Poolside
  /input \(\d+ tokens\) is longer than the model'?s context length \(\d+ tokens\)/i, // Together AI
  /exceeds the limit of \d+/i, // GitHub Copilot
  /(?:exceeds the available context size|context size has been exceeded)/i, // llama.cpp server
  /decoder prompt \(length [\d,]+\)(?: plus the number of requested output tokens \(at least 1\))? is longer than the maximum model length of [\d,]+/i, // vLLM input processor
  /engine prompt length [\d,]+ exceeds the max_model_len [\d,]+/i, // vLLM Responses API
  /`?inputs`? tokens \+ `?max_new_tokens`? must be <= [\d,]+/i, // Hugging Face TGI
  /`?inputs`? must have less than [\d,]+ tokens/i, // Hugging Face TGI
  /greater than the context length|model is loaded with context length of only \d[\d,]* tokens, which is not enough/i, // LM Studio
  /context window exceeds limit/i, // MiniMax
  /exceeded model token limit/i, // Kimi For Coding
  /tokens? in request more than max tokens? allowed/i, // Z.AI / Zhipu GLM error 1210
  /prompt exceeds max(?:imum)? length/i, // Z.AI / Zhipu GLM error 1261
  /range of input length should be \[1, [\d,]+\]/i, // DashScope (Model Studio) input-length limit
  /length of prompt_tokens \([\d,]+\) must be less than max_seq_len \([\d,]+\)/i, // SiliconFlow error 20015
  /too large for model with \d+ maximum context length/i, // Mistral
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /model_context_window_exceeded/i, // z.ai non-standard finish_reason surfaced as error text
  /prompt too long; exceeded (?:max )?context length/i, // Ollama explicit overflow error
  /context[_ ]length[_ ]exceeded/i, // Generic fallback
  /too many tokens/i, // Generic fallback
  /token limit exceeded/i, // Generic fallback
  /^413\s*(?:status code)?\s*\(no body\)/i, // Cerebras: 413 with no body
];

const FAILOVER_EXPLICIT_OVERFLOW_PATTERNS = [
  REQUEST_BUDGET_OVERFLOW_RE,
  /request_too_large/i, // Anthropic request byte-size overflow
  /context_overflow/i,
  CONFIGURED_CONTEXT_SIZE_OVERFLOW_RE, // DS4 server
  /invalid_argument[\s\S]*maximum number of tokens/i, // Google/Vertex
  /request exceeds the maximum size/i, // Anthropic
  /context length exceeded/i,
  /maximum context length/i,
  /prompt is too long/i,
  /prompt too long/i,
  /exceeds model context window/i,
  /model token limit/i,
  /input exceeds[\s\S]*maximum number of tokens/i,
  /^(?=[\s\S]*context window)(?=[\s\S]*ran out of (?:room|space))/i, // Codex
  /request size exceeds[\s\S]*context window/i,
  /context overflow:/i,
  /exceed context limit/i,
  /exceeds the model'?s maximum context/i,
  /max_tokens[\s\S]*exceed[\s\S]*context/i,
  /input(?: length[\s\S]*exceed[\s\S]*context| \([\d,]+\s*tokens?\) is longer than (?:the )?model'?s context length)/i,
  /413[\s\S]*too large/i,
  /context_window_exceeded/i,
  /input length [\d,]+\s+tokens? exceeds the model limit/i,
  /`?inputs`? tokens \+ `?max_new_tokens`? must be <= [\d,]+/i, // Hugging Face TGI
  /`?inputs`? must have less than [\d,]+ tokens/i, // Hugging Face TGI
  /上下文过长|上下文超出|上下文长度超|超出最大上下文|请压缩上下文/,
];

const PROVIDER_FALLBACK_OVERFLOW_PATTERNS = [
  /\binput token count exceeds the maximum number of input tokens\b/i, // AWS Bedrock
  /\binput is too long for this model\b/i, // AWS Bedrock stream errors
  /\binput exceeds the maximum number of tokens\b/i, // Google Vertex / Gemini
  /\bollama error:\s*context length exceeded(?:,\s*too many tokens)?\b/i,
  /\btotal tokens?.*exceeds? (?:the )?(?:model(?:'s)? )?(?:max|maximum|limit)/i, // Cohere
  /\b(?:(?:request|prompt) \(\d[\d,]*\s*tokens?\) exceeds (?:the )?available context size|context size has been exceeded)\b/i, // llama.cpp
  /\binput (?:is )?too long for (?:the )?model\b/i,
];

const CONTEXT_OVERFLOW_PATTERN_SCOPES = {
  "assistant-error": ASSISTANT_OVERFLOW_PATTERNS,
  "failover-explicit": FAILOVER_EXPLICIT_OVERFLOW_PATTERNS,
  "provider-fallback": PROVIDER_FALLBACK_OVERFLOW_PATTERNS,
  "failover-hint": [
    /context.*overflow|context window.*(too (?:large|long)|exceed|over|limit|max(?:imum)?|requested|sent|tokens)|prompt.*(too (?:large|long)|exceed|over|limit|max(?:imum)?)|(?:request|input).*(?:context|window|length|token).*(too (?:large|long)|exceed|over|limit|max(?:imum)?)/i,
  ],
  "context-window-too-small": [/context window.*(too small|minimum is)/i],
  "tpm-rate-limit-hint": [/\btpm\b|tokens per minute/i],
  "rate-limit-hint": [
    /rate limit|too many requests|requests per (?:minute|hour|day)|quota|throttl|429\b|tokens per day/i,
  ],
} as const;

export type ContextOverflowMessageScope = keyof typeof CONTEXT_OVERFLOW_PATTERN_SCOPES;

/** Match one canonical context-overflow wording scope without applying caller policy. */
export function matchesContextOverflowMessage(
  errorMessage: string,
  scope: ContextOverflowMessageScope,
): boolean {
  return CONTEXT_OVERFLOW_PATTERN_SCOPES[scope].some((pattern: RegExp) =>
    pattern.test(errorMessage),
  );
}

// Bedrock throttling can say "too many tokens" without exhausting the context window.
const NON_OVERFLOW_PATTERNS = [
  /^(Throttling error|Service unavailable):/i, // AWS Bedrock non-overflow errors (human-readable prefixes from formatBedrockError)
  /rate limit/i, // Generic rate limiting
  /too many requests/i, // Generic HTTP 429 style
];

function resolveContextInputTokens(message: AssistantMessage): number | undefined {
  if (message.usage.contextUsage?.state === "available") {
    return message.usage.contextUsage.promptTokens;
  }
  if (message.usage.contextUsage?.state === "unavailable") {
    return undefined;
  }
  // Cache writes are prompt tokens even when providers omit them from `input`.
  return message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
}

/**
 * Match provider overflow errors, or infer overflow from reported context usage.
 * A context window enables silent-overflow detection; silent truncation without
 * a length stop remains undetectable because the original token count is unknown.
 */
export function isContextOverflow(message: AssistantMessage, contextWindow?: number): boolean {
  // A refusal explanation can mention overflow without authorizing compact-and-retry.
  if (isProviderRefusalAssistantError(message)) {
    return false;
  }
  if (message.stopReason === "error" && message.errorMessage) {
    const errorMessage = message.errorMessage;
    const isNonOverflow = NON_OVERFLOW_PATTERNS.some((p) => p.test(errorMessage));
    if (!isNonOverflow && matchesContextOverflowMessage(errorMessage, "assistant-error")) {
      return true;
    }
  }

  if (contextWindow && message.stopReason === "stop") {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens > contextWindow) {
      return true;
    }
  }

  // Xiaomi truncates to the context window and reports length with no output.
  if (contextWindow && message.stopReason === "length" && message.usage.output === 0) {
    const inputTokens = resolveContextInputTokens(message);
    if (inputTokens !== undefined && inputTokens >= contextWindow * 0.99) {
      return true;
    }
  }

  return false;
}
