/* ============================================================================
 * main/providers/index.ts —— Provider 注册中心
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 管理所有 Provider 实例（本地 + 免费云端）
 *   2. 密钥存储（electron-store，主进程持有，渲染进程永不接触明文）
 *   3. 按当前选择创建对应 Provider 实例
 *   4. 探测所有来源的可用性，供 UI 展示
 *
 * 免费模型推荐配置（开箱即用，不需要任何付费）：
 *   ① Ollama 本地   → 完全免费无限量（需装 Ollama + 拉模型）
 *   ② OpenRouter    → 模型 id 带 :free，50 次/天（无需信用卡）
 *   ③ Gemini        → 免费层 1500 次/天，上下文 1M
 *   ④ Groq          → 免费层 1000 次/天，速度极快
 * ========================================================================== */
import { ProviderKind, ProviderConfig, ModelInfo } from '../../shared/types';
import { Provider } from './types';
import { OllamaProvider } from './ollama';
import { OpenAICompatProvider } from './openai-compatible';
import { GeminiProvider } from './gemini';
import { cpus } from 'node:os';

export interface ProviderSlot {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
  freeQuota: string;
  local: boolean;
  docsUrl: string;
  hint: string;
}

/** 所有内置的 Provider 槽位（用户可在设置里改 baseUrl / model） */
export const SLOTS: ProviderSlot[] = [
  {
    kind: 'ollama',
    name: 'Ollama 本地',
    baseUrl: 'http://127.0.0.1:11434',
    defaultModel: 'glm4:9b',
    needsKey: false,
    freeQuota: '完全免费 · 无限量 · 离线可用',
    local: true,
    docsUrl: 'https://ollama.com/download',
    hint: '安装 Ollama 后运行：ollama pull qwen3:8b（8G内存推荐）/ qwen3:4b（轻量）',
  },
  {
    kind: 'openrouter',
    name: 'OpenRouter 免费层',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/free',
    needsKey: true,
    freeQuota: '免费模型 $0/token · 20次/分 · 50次/天',
    local: false,
    docsUrl: 'https://openrouter.ai/keys',
    hint: '注册后创建 Key（免费额度，无需绑卡）。推荐模型：openrouter/free（自动路由）或带 :free 后缀的模型',
  },
  {
    kind: 'gemini',
    name: 'Google Gemini 免费层',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    defaultModel: 'gemini-2.5-flash',
    needsKey: true,
    freeQuota: '免费层约 1500 次/天 · 上下文 1M',
    local: false,
    docsUrl: 'https://aistudio.google.com/app/apikey',
    hint: '在 AI Studio 免费申请 API Key',
  },
  {
    kind: 'groq',
    name: 'Groq 免费层',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    needsKey: true,
    freeQuota: '30 次/分 · 1000 次/天 · LPU 高速',
    local: false,
    docsUrl: 'https://console.groq.com/keys',
    hint: '注册后创建 API Key',
  },
  {
    kind: 'custom',
    name: '自定义端点',
    baseUrl: 'http://127.0.0.1:8000/v1',
    defaultModel: 'local-model',
    needsKey: false,
    freeQuota: '取决于你的服务端',
    local: true,
    docsUrl: 'https://github.com/yourname/devai-studio',
    hint: '任何 OpenAI 兼容端点（vLLM / llama.cpp server / LM Studio / Xinference）',
  },
];

export interface SlotOverride {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

/** Provider 注册中心 */
export class ProviderRegistry {
  private slots = new Map<ProviderKind, ProviderSlot>();
  private overrides = new Map<ProviderKind, SlotOverride>();
  /** 当前选中的来源 */
  current: ProviderKind = 'ollama';
  /**
   * 推理线程数。默认取「CPU 核心数」而非减半封顶（兼容无 GPU 的慢机器），
   * 最终由 OllamaProvider.adjustToHardware() 根据显存/核数自适应精准设置：
   *   · 有 GPU → 一半核心辅助（GPU 主算）
   *   · 无 GPU → 用满全部核心（最快）
   * 用户仍可在「引擎」设置里手动指定一个数值或 0（用满全部核心），
   * 手动设置时会置 threadsUserSet=true，不再被自适应覆盖。
   */
  numThread = cpus().length;
  /** 用户在引擎设置里手动指定过线程数（此时不再自动覆盖） */
  threadsUserSet = false;

  constructor(overrides: Record<string, SlotOverride> = {}) {
    for (const s of SLOTS) this.slots.set(s.kind, s);
    for (const [k, v] of Object.entries(overrides || {})) {
      this.overrides.set(k as ProviderKind, v);
    }
  }

  getSlot(kind: ProviderKind): ProviderSlot | undefined {
    return this.slots.get(kind);
  }

  allSlots(): ProviderSlot[] {
    return [...this.slots.values()];
  }

  setOverride(kind: ProviderKind, o: SlotOverride) {
    const prev = this.overrides.get(kind) || {};
    this.overrides.set(kind, { ...prev, ...o });
  }

  getOverride(kind: ProviderKind): SlotOverride {
    return this.overrides.get(kind) || {};
  }

  /** 列出某来源已配置的模型 */
  async listModels(kind: ProviderKind): Promise<ModelInfo[]> {
    const p = this.create(kind);
    if (!p) return [];
    return p.listModels();
  }

  /** 本地已安装模型缓存（避免每次都查 Ollama） */
  private installedCache: { at: number; ids: string[] } | null = null;

  /** 查出本地已安装的模型 id 列表 */
  async installedLocalModels(): Promise<string[]> {
    const now = Date.now();
    if (this.installedCache && now - this.installedCache.at < 15000) {
      return this.installedCache.ids;
    }
    const p = this.create('ollama');
    let ids: string[] = [];
    if (p) {
      const models = await p.listModels();
      ids = models.map(m => m.id);
    }
    this.installedCache = { at: now, ids };
    return ids;
  }

  /**
   * 智能回落：当前配置模型本地没装 → 自动选一个已装的
   * （避免用户第一次用就报 "model not found"）
   */
  async resolveModel(kind: ProviderKind): Promise<string> {
    const slot = this.slots.get(kind);
    if (!slot) return '';
    const ov = this.overrides.get(kind) || {};
    const want = ov.model || slot.defaultModel;

    if (kind === 'ollama') {
      const installed = await this.installedLocalModels();
      if (!installed.length) return want;          // 一个都没装，返回默认（后面会报错提示）
      if (installed.includes(want)) return want;
      // 尝试前缀匹配（qwen3:8b → qwen3:4b 也算前缀，但要用更宽松的匹配）
      const stem = want.split(':')[0];
      const sameStem = installed.find(id => id.split(':')[0].toLowerCase() === stem.toLowerCase());
      if (sameStem) return sameStem;
      // 没有任何配置文件 → 用已装的第一个
      return installed[0];
    }
    return want;
  }

  /** 创建 Provider 实例 */
  create(kind: ProviderKind = this.current): Provider | null {
    const slot = this.slots.get(kind);
    if (!slot) return null;
    const ov = this.overrides.get(kind) || {};
    const baseUrl = ov.baseUrl || slot.baseUrl;
    const model = ov.model || slot.defaultModel;
    const apiKey = ov.apiKey || '';

    switch (kind) {
      case 'ollama': {
        const p = new OllamaProvider(baseUrl, model);
        if (this.threadsUserSet) {
          p.numThread = this.numThread;   // 用户手动指定 → 不覆盖
        } else {
          p.numThread = this.numThread;   // 默认：由 adjustToHardware 精确自适应
        }
        return p;
      }
      case 'gemini':
        return new GeminiProvider(apiKey, model, baseUrl);
      case 'openrouter':
        return new OpenAICompatProvider({
          kind, name: slot.name, baseUrl, model, apiKey,
          freeQuota: slot.freeQuota,
          // OpenRouter 免费模型过滤：只留 :free 与 openrouter/free
          modelFilter: (m: any) => {
            const id = m.id || '';
            return id.endsWith(':free') || id === 'openrouter/free';
          },
        });
      case 'groq':
        return new OpenAICompatProvider({
          kind, name: slot.name, baseUrl, model, apiKey,
          freeQuota: slot.freeQuota,
        });
      case 'custom':
        return new OpenAICompatProvider({
          kind, name: slot.name, baseUrl, model, apiKey,
          freeQuota: slot.freeQuota,
        });
      default:
        return null;
    }
  }

  /** 探测所有来源 */
  async probeAll(): Promise<Array<{ kind: ProviderKind; ok: boolean; message: string; latencyMs?: number }>> {
    const out: Array<{ kind: ProviderKind; ok: boolean; message: string; latencyMs?: number }> = [];
    for (const slot of SLOTS) {
      const p = this.create(slot.kind);
      if (!p) continue;
      const r = await p.probe();
      out.push({ kind: slot.kind, ...r });
    }
    return out;
  }

  /** 当前 Provider 的可用描述（给渲染进程看，不含密钥） */
  describe(): ProviderConfig {
    const slot = this.slots.get(this.current)!;
    const ov = this.overrides.get(this.current) || {};
    return {
      kind: this.current,
      name: slot.name,
      baseUrl: ov.baseUrl || slot.baseUrl,
      model: ov.model || slot.defaultModel,
      local: slot.local,
      freeQuota: slot.freeQuota,
    };
  }

  setCurrent(kind: ProviderKind) {
    if (this.slots.has(kind)) this.current = kind;
  }
}

export { Provider, OllamaProvider, OpenAICompatProvider, GeminiProvider };
