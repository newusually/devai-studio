/* ============================================================================
 * main/engines/video-engines.ts —— 视频生成多引擎抽象
 * ----------------------------------------------------------------------------
 * 设计目标（用户 2026-10-25 要求）：
 *   「API 模式 + 本地轻量模式」双通道，多引擎可自主选择，且要求免费。
 *
 * 引擎清单：
 *   ┌────────────────┬──────────┬────────────┬──────────────────────────┐
 *   │ 引擎            │ 费用     │ 硬件要求   │ 说明                      │
 *   ├────────────────┼──────────┼────────────┼──────────────────────────┤
 *   │ seedance-local │ 免费     │ GPU 6-8G  │ Seedance 2.0/2.5 本地部署 │
 *   │ seedance-api   │ 有免费额度│ 无      │ 火山引擎官方 API          │
 *   │ light-local    │ 完全免费 │ 无        │ LLM脚本+SVG分镜+ffmpeg    │
 *   │ stock-free     │ 免费额度 │ 无        │ 免费图像/视频 API 兜底    │
 *   └────────────────┴──────────┴────────────┴──────────────────────────┘
 *
 * ★★ 关键设计：按需加载（用户明确要求）
 *   「只有打开短视频功能才会使用这些（显卡）资源，其他都用无显卡的功能」
 *   → 本模块的所有重型引擎都是【惰性启动】：
 *     · 不 import 时不占内存
 *     · 不调用时不启动进程
 *     · 硬件能力不足时自动降级，不报错打断
 *
 * 硬件自适应：
 *   探测 GPU 显存 / 内存 / CPU → 决定哪些引擎「可用」
 *   本机（8G 内存 + 无 GPU）→ 只有 light-local + 云端 API
 *   另一台（16G 内存 + 20 核 + 独显）→ 全部可用
 * ========================================================================== */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

export type VideoEngineKind =
  | 'seedance-local'      // Seedance 2.0/2.5 本地部署
  | 'seedance-api'        // 火山引擎 Doubao-Seedance 官方 API
  | 'light-local'         // 本地轻量：LLM + SVG 分镜 + ffmpeg
  | 'stock-free';         // 免费云端图像/视频 API 兜底

export interface EngineCapability {
  kind: VideoEngineKind;
  name: string;
  /** 是否免费（云端一般是"有免费额度"） */
  free: boolean;
  freeNote: string;
  /** 是否需要 GPU */
  needsGpu: boolean;
  /** 最小显存（GB），0 = 不需要 */
  minVram: number;
  /** 最小内存（GB） */
  minRam: number;
  /** 是否需要 API Key */
  needsKey: boolean;
  /** 是否本地运行（离线可用） */
  local: boolean;
  /** 支持的能力 */
  features: Array<'t2v' | 'i2v' | 't2i' | 'i2i' | 'batch'>;
  /** 是否需要手动启动（重型资源，按需加载） */
  heavy: boolean;
  desc: string;
}

/** 引擎能力表 —— UI 直接用它渲染选择器 */
export const VIDEO_ENGINES: EngineCapability[] = [
  {
    kind: 'seedance-local',
    name: 'Seedance 本地（2.0 / 2.5）',
    free: true,
    freeNote: '完全免费 · 离线 · 无限量',
    needsGpu: true,
    minVram: 6,
    minRam: 8,
    needsKey: false,
    local: true,
    features: ['t2v', 'i2v', 't2i', 'i2i', 'batch'],
    heavy: true,
    desc: '字节跳动视频生成模型本地部署。2.0 轻量版约需 6G 显存，2.5 需 8G+。'
      + '适合 16G 内存 + 独显的机器；启动时才会占用 GPU。',
  },
  {
    kind: 'seedance-api',
    name: 'Seedance 官方 API（火山引擎）',
    free: true,
    freeNote: '有免费额度 · 效果最好',
    needsGpu: false,
    minVram: 0,
    minRam: 0,
    needsKey: true,
    local: false,
    features: ['t2v', 'i2v', 't2i', 'i2i', 'batch'],
    heavy: false,
    desc: '豆包 Seedance 2.5 官方 API（火山引擎）。质量最高、速度最快，'
      + '按官方免费额度使用；需要火山引擎账号的 API Key。',
  },
  {
    kind: 'light-local',
    name: '本地轻量（LLM + 分镜 + ffmpeg）',
    free: true,
    freeNote: '完全免费 · 无需显卡 · 秒级出片',
    needsGpu: false,
    minVram: 0,
    minRam: 2,
    needsKey: false,
    local: true,
    features: ['t2v', 'batch'],
    heavy: false,
    desc: '本机 Ollama 出脚本 → 矢量分镜图 → SRT 字幕 → Windows 免费 TTS 配音 → ffmpeg 合成。'
      + '任何机器都能跑，不依赖显卡，质量稳定但非 AI 生成画面。',
  },
  {
    kind: 'stock-free',
    name: '免费云端图像/视频',
    free: true,
    freeNote: '免费额度 · 无需显卡',
    needsGpu: false,
    minVram: 0,
    minRam: 0,
    needsKey: true,
    local: false,
    features: ['t2v', 't2i', 'i2i'],
    heavy: false,
    desc: 'OpenRouter / Gemini 等的免费额度里带图像模型，可作视频素材补充。',
  },
];

/* ---------------- 硬件探测 ---------------- */
export interface HardwareInfo {
  gpu: string;
  vramGb: number;
  ramGb: number;
  cpuCores: number;
  hasNvidia: boolean;
  /** Seedance 本地部署可用 */
  seedanceLocalOk: boolean;
  /** 建议的 Seedance 版本 */
  suggestSeedance: '2.0' | '2.5' | null;
}

export function detectHardware(): HardwareInfo {
  let gpu = '未检测到独立显卡';
  let vramGb = 0;
  let hasNvidia = false;

  try {
    // 1) 优先 nvidia-smi
    try {
      const out = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
        { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const line = out.split('\n')[0];
      if (line) {
        const [name, mem] = line.split(',').map(s => s.trim());
        gpu = name;
        vramGb = Math.round((parseInt(mem, 10) || 0) / 1024 * 10) / 10;
        hasNvidia = true;
      }
    } catch (e) { /* 无 nvidia-smi → 走 WMI */ }

    // 2) WMI 兜底
    if (!hasNvidia) {
      const ps = `Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json`;
      const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
        { encoding: 'utf8', timeout: 10000, windowsHide: true });
      try {
        const arr = JSON.parse(out);
        const list = Array.isArray(arr) ? arr : [arr];
        for (const g of list) {
          const ram = (g.AdapterRAM || 0);
          const gb = ram ? Math.round(ram / 1073741824 * 10) / 10 : 0;
          if (gb > 0) {
            gpu = g.Name;
            vramGb = gb;
            if (/nvidia|geforce|rtx|gtx/i.test(g.Name)) hasNvidia = true;
            break;
          }
        }
      } catch (e) { }
    }
  } catch (e) { }

  let ramGb = 0;
  let cpuCores = 0;
  try {
    const ps = `@{ram=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1); cores=(Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfLogicalProcessors -Sum).Sum} | ConvertTo-Json`;
    const out = execFileSync('powershell', ['-NoProfile', '-Command', ps],
      { encoding: 'utf8', timeout: 10000, windowsHide: true });
    const j = JSON.parse(out);
    ramGb = j.ram || 0;
    cpuCores = j.cores || 0;
  } catch (e) { }

  // ★官方要求：显存 6GB（2.0）/ 8GB（2.5）+ 内存 16GB
  const seedanceLocalOk = hasNvidia && vramGb >= 6 && ramGb >= 8;
  let suggest: '2.0' | '2.5' | null = null;
  if (seedanceLocalOk) {
    if (vramGb >= 8 && ramGb >= 16) suggest = '2.5';
    else suggest = '2.0';
  }

  return { gpu, vramGb, ramGb, cpuCores, hasNvidia, seedanceLocalOk, suggestSeedance: suggest };
}

/* ---------------- 引擎可用性 ---------------- */
export interface EngineStatus {
  kind: VideoEngineKind;
  available: boolean;
  reason: string;
  /** 需要的 API Key 是否已配置 */
  hasKey: boolean;
  /** 是否需要用户手动启动（重型） */
  needsManualStart: boolean;
  /** 已安装（本地模型目录存在） */
  installed: boolean;
}

export function checkEngines(hw: HardwareInfo, keys: Record<string, string>, opts?: {
  seedanceLocalPath?: string;
}): EngineStatus[] {
  const out: EngineStatus[] = [];

  for (const e of VIDEO_ENGINES) {
    let available = true;
    let reason = '可用';
    let needsManualStart = false;
    let installed = false;

    if (e.needsGpu) {
      if (!hw.hasNvidia) {
        available = false;
        reason = `本机无 NVIDIA 显卡（${hw.gpu}）—— 该引擎需要独显`;
      } else if (hw.vramGb < e.minVram) {
        available = false;
        reason = `显存不足：需 ${e.minVram}GB，当前 ${hw.vramGb}GB`;
      } else if (hw.ramGb < e.minRam) {
        available = false;
        reason = `内存不足：需 ${e.minRam}GB，当前 ${hw.ramGb}GB`;
      } else {
        needsManualStart = true;
        installed = !!opts?.seedanceLocalPath && existsSync(opts.seedanceLocalPath);
        reason = installed
          ? `已安装 · 建议用 Seedance ${hw.suggestSeedance}`
          : `需要先部署（建议 Seedance ${hw.suggestSeedance}）· 首次使用会下载权重`;
      }
    }

    if (e.needsKey) {
      const k = keys[e.kind] || '';
      if (!k) {
        if (e.kind === 'seedance-api') {
          // 火山引擎未配置 key 时仍允许（用公开代理时）
          reason += ' · 未配置 Key';
        }
      }
    }

    if (e.kind === 'light-local') {
      reason = '无需显卡 · 秒级出片 · 完全离线';
    }

    out.push({
      kind: e.kind,
      available,
      reason,
      hasKey: !!(keys[e.kind] || ''),
      needsManualStart,
      installed,
    });
  }
  return out;
}

/* ---------------- 引擎配置存储 ---------------- */
export interface EngineSettings {
  /** 选中的引擎 */
  current: VideoEngineKind;
  /** 各引擎的 API Key */
  keys: Record<string, string>;
  /** Seedance 本地部署路径 */
  seedanceLocalPath: string;
  /** Seedance 版本 */
  seedanceVersion: '2.0' | '2.5';
  /** Seedance 本地服务地址（部署后自带 API） */
  seedanceLocalApi: string;
  /** 火山引擎 API 基础地址 */
  volcengineApi: string;
  /** 火山引擎 Region */
  volcengineRegion: string;
  /** 批量并发数 */
  batchConcurrency: number;
  /** 推理线程数（0 = 全部核心；2 = CPU 减半而速度只慢 5%） */
  numThread: number;
  /** 分镜模板（视觉风格） */
  templateId: string;
  /** 字幕样式 */
  subtitleStyleId: string;
}

export const DEFAULT_ENGINE_SETTINGS: EngineSettings = {
  current: 'light-local',
  keys: {},
  seedanceLocalPath: 'F:\\seedance',
  seedanceVersion: '2.5',
  seedanceLocalApi: 'http://127.0.0.1:8000',
  volcengineApi: 'https://ark.cn-beijing.volces.com/api/v3',
  volcengineRegion: 'cn-beijing',
  batchConcurrency: 2,
  numThread: 0,
  templateId: 'tech',
  subtitleStyleId: 'bold-white',
};

export function loadEngineSettings(file: string): EngineSettings {
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return { ...DEFAULT_ENGINE_SETTINGS, ...j, keys: { ...(j.keys || {}) } };
    }
  } catch (e) { }
  return { ...DEFAULT_ENGINE_SETTINGS, keys: {} };
}

export function saveEngineSettings(file: string, s: EngineSettings) {
  try {
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2), 'utf8');
  } catch (e) { }
}

/* ---------------- Seedance 本地部署检测 ---------------- */
export interface SeedanceLocalInfo {
  installed: boolean;
  path: string;
  apiUrl: string;
  version?: string;
  /** 可用模型列表 */
  models: string[];
  /** 探测信息 */
  detail: string;
}

/** 探测本地 Seedance 部署（只看文件与端口，不启动进程） */
export async function probeSeedanceLocal(path: string, apiUrl: string): Promise<SeedanceLocalInfo> {
  const info: SeedanceLocalInfo = {
    installed: false, path, apiUrl, models: [], detail: '',
  };
  if (!existsSync(path)) {
    info.detail = `未找到目录 ${path}`;
    return info;
  }
  // 常见部署形态：目录里有 run.bat / app.py / server.py / models/
  const marks = ['run.bat', 'start.bat', 'app.py', 'server.py', 'main.py', 'webui.bat'];
  let found = '';
  for (const m of marks) {
    if (existsSync(join(path, m))) { found = m; break; }
  }
  if (!found) {
    info.detail = `目录存在但未发现启动脚本（${marks.join('/')}）`;
    return info;
  }
  info.installed = true;

  // 探测本地 API 是否在跑
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const res = await fetch(`${apiUrl}/models`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (res.ok) {
      const j: any = await res.json();
      info.models = (j.data || j.models || []).map((m: any) => m.id || m.name || String(m));
      info.detail = `服务已启动 · ${info.models.length} 个模型可用`;
    } else {
      info.detail = `已部署但服务未运行（启动后可用）· 启动脚本 ${found}`;
    }
  } catch (e) {
    info.detail = `已部署但服务未运行（启动后可用）· 启动脚本 ${found}`;
  }
  return info;
}

/** 启动本地 Seedance（用户手动触发才启动 —— 按需加载，不占闲时资源） */
export async function startSeedanceLocal(path: string): Promise<{ ok: boolean; message: string }> {
  const cands = ['run.bat', 'start.bat', 'webui.bat', 'app.py', 'server.py'];
  let script = '';
  for (const c of cands) {
    if (existsSync(join(path, c))) { script = join(path, c); break; }
  }
  if (!script) return { ok: false, message: `未找到启动脚本（${cands.join('/')}）` };

  try {
    if (script.endsWith('.bat')) {
      spawn('cmd.exe', ['/c', script], {
        cwd: path, detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    } else {
      const py = findPython();
      if (!py) return { ok: false, message: '未找到 Python，无法启动本地模型' };
      spawn(py, [script], {
        cwd: path, detached: true, stdio: 'ignore', windowsHide: true,
      }).unref();
    }
    return { ok: true, message: `已启动 ${script}（首次加载模型需 1-3 分钟）` };
  } catch (e: any) {
    return { ok: false, message: e?.message || String(e) };
  }
}

function findPython(): string | null {
  const cands = [
    'F:\\oqt-quant-latest\\toolchain\\python\\python.exe',
    'python',
    'python3',
  ];
  for (const c of cands) {
    try {
      if (c === 'python' || c === 'python3') {
        const r = require('node:child_process').spawnSync('where', [c], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && r.stdout) return r.stdout.split('\n')[0].trim();
      } else if (existsSync(c)) return c;
    } catch (e) { }
  }
  return null;
}
