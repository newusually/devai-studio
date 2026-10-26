/* ============================================================================
 * main/hardware.ts —— 硬件自适应（有 GPU 就用 GPU，没有就用 CPU）
 * ----------------------------------------------------------------------------
 * 目标：让软件在任意机器上都把本地推理速度调到接近该机的上限——
 *   · 检测到 NVIDIA 显卡（有显存）→ 完全交给 Ollama GPU 加速（num_gpu 拉满）+ CPU 辅助
 *   · 无独立显卡（纯 CPU）       → 用满全部 CPU 核心（num_thread=逻辑核数），不再砍半
 *   · 内存不足 → 给出降档建议（提示换小模型）
 * 结果缓存在本模块，聊天气泡/引擎面板可复用，避免反复执行耗时命令。
 * ========================================================================== */
import { cpus, totalmem } from 'node:os';
import { execFile } from 'node:child_process';

export interface HardwareInfo {
  /** true = 检测到可用 NVIDIA GPU（可做 Ollama GPU 推理） */
  hasGPU: boolean;
  /** GPU 显存（GB，0 = 未知/无独显） */
  vramGb: number;
  /** GPU 名称（无则空串） */
  gpuName: string;
  /** 逻辑 CPU 核心数 */
  cpuCores: number;
  /** 物理内存（GB，一位小数） */
  memGb: number;
  /** 是否有足够内存/显存跑至少一个 1B 模型兜底 */
  usable: boolean;
  /** 建议的 Ollama 推理线程数（num_thread） */
  suggestThreads: number;
  /** 建议的 num_gpu（>0 =放 GPU 的层数/拉满；-1 = 纯 CPU） */
  suggestNumGPU: number;
  /** 简洁中文描述，用于界面展示 */
  summary: string;
}

let cached: HardwareInfo | null = null;

function logicalCores(): number {
  return (cpus() || []).length || 4;
}

/** 通过 nvidia-smi 询问 NVIDIA 显卡（驱动正常才返回）。 */
function queryNvidia(): Promise<{ name: string; vramGb: number } | null> {
  return new Promise((resolve) => {
    execFile(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 4000, windowsHide: true },
      (err, stdout) => {
        if (err) return resolve(null);
        const line = (stdout || '').trim().split(/\r?\n/)[0] || '';
        const m = line.match(/^(.*?),\s*(\d+)\s*$/);
        if (!m) return resolve(null);
        const mb = Number(m[2]);
        resolve({ name: m[1].trim(), vramGb: mb > 0 ? Math.round(mb / 1024) : 0 });
      }
    );
  });
}

/** 获取（并缓存）硬件信息 + 推理建议。force=true 强制重扫。 */
export async function detectHardware(force = false): Promise<HardwareInfo> {
  if (cached && !force) return cached;
  const cpu = logicalCores();
  const memGb = Math.round((totalmem() / 1024 / 1024 / 1024) * 10) / 10;
  const nvidia = await queryNvidia();
  const hasGPU = !!nvidia && nvidia.vramGb > 0;
  const vramGb = nvidia?.vramGb || 0;
  const gpuName = nvidia?.name || '';

  let suggestThreads: number;
  let suggestNumGPU: number;
  let summary: string;
  if (hasGPU) {
    // 有 GPU：GPU 主算（token 生成），CPU 负责 prompt 预填充/调度，取一半核心（封顶 8）避免抢占
    suggestThreads = Math.max(2, Math.min(8, Math.round(cpu / 2)));
    suggestNumGPU = 999; // 让 Ollama 把能放的全部塞进显存
    summary = `🎮 ${gpuName} ${vramGb}GB · ${cpu} 核 CPU。GPU 加速已启用，CPU ${suggestThreads} 线程辅助。`;
    if (vramGb < 8) summary += ' 注：内置 Ollama 为纯 CPU 推理，能否运行模型取决于系统内存（16GB 可跑 ≤9B），而非显存。';
  } else {
    // 无 GPU：用满全部核心，解决"比官方慢"
    suggestThreads = cpu;
    suggestNumGPU = -1;
    summary = `无独立显卡 → 纯 CPU 推理，已用满全部 ${cpu} 核。`;
    if (cpu <= 4) summary += ' 核少，建议 ≤7B 模型保证可交互。';
  }

  const info: HardwareInfo = {
    hasGPU, vramGb, gpuName, cpuCores: cpu, memGb,
    usable: memGb >= 4,
    suggestThreads, suggestNumGPU, summary,
  };
  cached = info;
  return info;
}