/* ============================================================================
 * main/engines/media.ts —— 媒体处理工作台（ffmpeg / ffprobe）
 * ----------------------------------------------------------------------------
 * 覆盖格式：
 *   视频  mp4 mov avi mkv webm flv wmv m4v mpg mpeg ts m2ts 3gp
 *   音频  mp3 wav flac aac m4a ogg opus wma amr
 *   图片  jpg jpeg png gif bmp webp tiff svg heic
 *   文档  pdf docx xlsx pptx txt md csv json xml html
 *
 * 能力：
 *   视频  抽帧 / 转码 / 裁剪 / 拼接 / 变速 / 旋转 / 加字幕 / 加水印 / 转 GIF
 *   音频  转码 / 裁剪 / 混音 / 响度归一 / 提取自视频 / 波形
 *   图片  格式转换 / 缩放 / 裁剪 / 旋转 / 拼图 / 加文字水印
 *   通用  元信息探测 / 格式识别
 *
 * ★ffmpeg 由 npm 包 ffmpeg-static 提供（随项目走，两台电脑都能用，不依赖系统安装）
 * ========================================================================== */
import { existsSync, mkdirSync, statSync, createReadStream, readFileSync, writeFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

let FFMPEG = '';
let FFPROBE = '';

/** 应用自带 ffmpeg 目录（一键安装部署位置：<resources>/ffmpeg/bin） */
function bundledFfmpegCands(): string[] {
  const cands: string[] = [];
  try {
    // Electron 打包版：process.resourcesPath = <安装目录>/resources
    cands.push(join(process.resourcesPath || '', 'ffmpeg', 'bin', 'ffmpeg.exe'));
  } catch { }
  try {
    // dev 模式：项目根 resources/
    cands.push(join(__dirname, '../../../resources/ffmpeg/bin/ffmpeg.exe'));
  } catch { }
  return cands.filter((c) => c && existsSync(c));
}

export function initMedia() {
  try {
    FFMPEG = require('ffmpeg-static');
  } catch (e) { FFMPEG = ''; }
  // ★优先用应用自带（一键安装部署到 resources/ffmpeg/bin 的版本）
  if (!FFMPEG) FFMPEG = bundledFfmpegCands()[0] || '';
  // 兜底：找系统 PATH 上的
  if (!FFMPEG) {
    try {
      const r = execFileSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
      FFMPEG = r.split('\n')[0].trim();
    } catch (e) { }
  }
  if (!FFPROBE) {
    try {
      const r = execFileSync('where', ['ffprobe'], { encoding: 'utf8', windowsHide: true });
      FFPROBE = r.split('\n')[0].trim();
    } catch (e) { }
  }
  if (!FFPROBE) {
    const same = join(FFMPEG || '', '..', 'ffprobe.exe');
    if (FFMPEG && existsSync(same)) FFPROBE = same;
  }
  return { ffmpeg: FFMPEG, ffprobe: FFPROBE };
}

/** ★ffmpeg 一键安装完成后由主进程调用：立即刷新运行时路径，无需重启应用 */
export function setFfmpegPaths(ffmpeg: string, ffprobe?: string) {
  if (ffmpeg) FFMPEG = ffmpeg;
  if (ffprobe) FFPROBE = ffprobe;
}

export function mediaAvailable(): boolean { return !!FFMPEG; }

/* ---------------- 格式分类 ---------------- */
export type MediaKind = 'video' | 'audio' | 'image' | 'document' | 'code' | 'unknown';

const VIDEO_EXT = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'vob', 'ogv', 'rmvb']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'opus', 'wma', 'amr', 'aiff', 'mid']);
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif']);
const DOC_EXT = new Set(['pdf', 'docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'txt', 'md', 'csv', 'rtf', 'odt', 'epub']);
const CODE_EXT = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'rb', 'swift', 'kt', 'sql', 'sh', 'bash', 'vue', 'svelte', 'html', 'css', 'scss', 'json', 'yaml', 'yml', 'toml', 'xml', 'ini']);

export function classify(file: string): MediaKind {
  const ext = extname(file).slice(1).toLowerCase();
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (DOC_EXT.has(ext)) return 'document';
  if (CODE_EXT.has(ext)) return 'code';
  return 'unknown';
}

export const SUPPORTED_FORMATS = {
  video: [...VIDEO_EXT],
  audio: [...AUDIO_EXT],
  image: [...IMAGE_EXT],
  document: [...DOC_EXT],
  code: [...CODE_EXT],
};

/* ---------------- 媒体信息探测 ---------------- */
export interface MediaInfo {
  file: string;
  name: string;
  kind: MediaKind;
  size: number;
  sizeText: string;
  /** 视频/音频时长（秒） */
  duration?: number;
  durationText?: string;
  width?: number;
  height?: number;
  fps?: number;
  /** 音频/视频编码 */
  vcodec?: string;
  acodec?: string;
  bitrate?: number;
  fpsText?: string;
  /** 图片尺寸 */
  size2?: { w: number; h: number };
  error?: string;
}

export function fmtSize(n: number): string {
  if (!n) return '0B';
  if (n < 1024) return n + 'B';
  if (n < 1048576) return (n / 1024).toFixed(1) + 'KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB';
  return (n / 1073741824).toFixed(2) + 'GB';
}

export function fmtDuration(sec: number): string {
  if (!isFinite(sec) || sec < 0) return '-';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

export async function probeMedia(file: string): Promise<MediaInfo> {
  const kind = classify(file);
  let size = 0;
  try { size = statSync(file).size; } catch (e) { }

  const info: MediaInfo = {
    file, name: basename(file), kind, size,
    sizeText: fmtSize(size),
  };

  if (!FFPROBE || !existsSync(file)) {
    if (kind === 'image') {
      try {
        const dim = await imageSize(file);
        info.size2 = dim;
        info.width = dim.w;
        info.height = dim.h;
      } catch (e) { }
    }
    return info;
  }

  try {
    const out = execFileSync(FFPROBE, [
      '-v', 'quiet', '-print_format', 'json',
      '-show_format', '-show_streams', file,
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    const j = JSON.parse(out);
    const streams = j.streams || [];
    const fmt = j.format || {};

    if (fmt.duration) {
      info.duration = parseFloat(fmt.duration);
      info.durationText = fmtDuration(info.duration);
    }
    if (fmt.bit_rate) info.bitrate = parseInt(fmt.bit_rate, 10);

    const v = streams.find((s: any) => s.codec_type === 'video');
    const a = streams.find((s: any) => s.codec_type === 'audio');
    if (v) {
      info.vcodec = v.codec_name;
      info.width = v.width;
      info.height = v.height;
      if (v.r_frame_rate && v.r_frame_rate.includes('/')) {
        const [n, d] = v.r_frame_rate.split('/').map(Number);
        if (d) info.fps = Math.round(n / d * 100) / 100;
      }
      if (kind === 'image') info.size2 = { w: v.width || 0, h: v.height || 0 };
    }
    if (a) {
      info.acodec = a.codec_name;
      if (a.channels) (info as any).channels = a.channels;
      if (a.sample_rate) (info as any).sampleRate = a.sample_rate;
    }
  } catch (e: any) {
    info.error = e?.message || String(e);
  }
  return info;
}

/** 读图片尺寸（不依赖 ffprobe） */
export async function imageSize(file: string): Promise<{ w: number; h: number }> {
  const buf = readFileSync(file);
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  // GIF
  if (buf.slice(0, 3).toString() === 'GIF') {
    return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
  }
  // BMP
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
  }
  // JPEG
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  // SVG
  const txt = buf.slice(0, 2048).toString('utf8');
  const vm = txt.match(/viewBox=["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vm) return { w: parseFloat(vm[1]), h: parseFloat(vm[2]) };
  const wm = txt.match(/width=["']\s*([\d.]+)/i);
  const hm = txt.match(/height=["']\s*([\d.]+)/i);
  if (wm && hm) return { w: parseFloat(wm[1]), h: parseFloat(hm[1]) };
  return { w: 0, h: 0 };
}

/* ---------------- ffmpeg 执行 ---------------- */
export function runFFmpeg(args: string[], onProgress?: (p: number) => void, timeoutMs = 0): Promise<{ ok: boolean; error?: string; stderr?: string }> {
  return new Promise((resolve) => {
    if (!FFMPEG) return resolve({ ok: false, error: 'ffmpeg 不可用' });
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let stderr = '';
    let timer: any = null;
    const finish = (res: { ok: boolean; error?: string; stderr?: string }) => {
      if (timer) clearTimeout(timer);
      resolve(res);
    };
    /* ★修复：ffmpeg 若卡死（坏输入/驱动问题）会让整个调用永远不返回。
     *   加硬超时，超时直接 SIGKILL，避免 UI 永久停在"生成中…"。 */
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try { p.kill('SIGKILL'); } catch { }
        finish({ ok: false, error: `ffmpeg 超时（${timeoutMs / 1000}s）被强制终止`, stderr: stderr.slice(-1500) });
      }, timeoutMs);
    }
    p.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (stderr.length > 200000) stderr = stderr.slice(-100000);
      if (onProgress) {
        const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m) {
          const sec = +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
          onProgress(sec);
        }
      }
    });
    p.on('close', code => {
      finish(code === 0
        ? { ok: true }
        : { ok: false, error: `ffmpeg 退出码 ${code}`, stderr: stderr.slice(-1500) });
    });
    p.on('error', (e: any) => finish({ ok: false, error: e?.message || String(e) }));
  });
}

/* ---------------- 视频操作 ---------------- */
export interface VideoOp {
  /** 输入文件（可多个 → 拼接） */
  inputs: string[];
  output: string;
  /** 起止时间（秒） */
  start?: number;
  duration?: number;
  /** 缩放 */
  width?: number;
  height?: number;
  /** 变速倍率（2 = 2 倍速） */
  speed?: number;
  /** 旋转角度 */
  rotate?: number;
  /** 音量（0-2） */
  volume?: number;
  /** 字幕文件（SRT） */
  subtitle?: string;
  /** 背景音乐 */
  bgm?: string;
  /** 音量（背景音乐） */
  bgmVolume?: number;
  /** GIF 输出 */
  gif?: boolean;
  /** 帧率 */
  fps?: number;
  /** 码率 */
  bitrate?: string;
}

export async function runVideoOp(op: VideoOp, onLog?: (s: string) => void): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  const outDir = join(op.output, '..');
  try { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }); } catch (e) { }

  const args: string[] = ['-y'];

  if (op.inputs.length > 1) {
    // 拼接：先做 concat 清单
    const listFile = join(outDir, '.concat.txt');
    writeFileSync(listFile, op.inputs.map(f => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    args.push('-f', 'concat', '-safe', '0', '-i', listFile);
  } else {
    if (op.start !== undefined) args.push('-ss', String(op.start));
    args.push('-i', op.inputs[0]);
  }

  if (op.duration !== undefined) args.push('-t', String(op.duration));

  // 滤镜链
  const filters: string[] = [];
  if (op.width || op.height) {
    filters.push(`scale=${op.width || -1}:${op.height || -1}`);
  }
  if (op.rotate) {
    filters.push(`rotate=${op.rotate * Math.PI / 180}:ow=rotw(iw):oh=roth(ih)`);
  }
  if (op.speed && op.speed !== 1) {
    filters.push(`setpts=${(1 / op.speed).toFixed(4)}*PTS`);
  }
  if (op.volume !== undefined && op.volume !== 1) {
    filters.push(`volume=${op.volume}`);
  }
  if (op.subtitle) {
    // 字幕路径里的冒号要转义
    const esc = op.subtitle.replace(/\\/g, '/').replace(/:/g, '\\:');
    filters.push(`subtitles='${esc}'`);
  }
  if (filters.length) args.push('-vf', filters.join(','));

  // 背景音乐混合
  if (op.bgm && existsSync(op.bgm)) {
    args.push('-stream_loop', '-1', '-i', op.bgm);
    const bgmVol = (op.bgmVolume ?? 0.15).toFixed(2);
    args.push('-filter_complex',
      `[0:a][1:a]amix=inputs=2:duration=first:weights=1 ${bgmVol}[a]`,
      '-map', '0:v', '-map', '[a]');
  }

  if (op.gif) {
    args.push('-vf', filters.concat(['fps=12', 'scale=480:-1:flags=lanczos', 'split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse']).join(','));
  }
  if (op.fps) args.push('-r', String(op.fps));
  if (op.bitrate) args.push('-b:v', op.bitrate);
  args.push('-pix_fmt', 'yuv420p');
  args.push(op.output);

  onLog?.(`ffmpeg ${op.inputs.length > 1 ? '(拼接) ' : ''}→ ${basename(op.output)}`);
  const r = await runFFmpeg(args);
  if (r.ok) onLog?.(`✓ 完成：${basename(op.output)}`);
  else onLog?.(`✗ 失败：${r.error}`);
  return { ok: r.ok, output: r.ok ? op.output : undefined, error: r.error };
}

/** 抽帧：每隔 N 秒取一帧 */
export async function extractFrames(
  input: string, outputDir: string, everySec = 5, maxFrames = 60
): Promise<{ ok: boolean; frames?: string[]; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  try { if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true }); } catch (e) { }
  const frames: string[] = [];
  const fps = 1 / Math.max(0.5, everySec);
  const pattern = join(outputDir, 'frame-%04d.jpg');
  const r = await runFFmpeg([
    '-y', '-i', input, '-vf', `fps=${fps},scale=480:-1`, '-q:v', '4',
    '-frames:v', String(maxFrames), pattern,
  ]);
  if (!r.ok) return { ok: false, error: r.error };
  for (let i = 1; i <= maxFrames; i++) {
    const f = join(outputDir, `frame-${String(i).padStart(4, '0')}.jpg`);
    if (existsSync(f)) frames.push(f); else break;
  }
  return { ok: true, frames };
}

/* ---------------- 音频操作 ---------------- */
export async function extractAudio(
  input: string, output: string, format = 'mp3'
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  const args = ['-y', '-i', input, '-vn'];
  if (format === 'mp3') args.push('-ar', '44100', '-b:a', '192k');
  if (format === 'wav') args.push('-ar', '44100', '-ac', '2');
  if (format === 'aac') args.push('-c:a', 'aac', '-b:a', '192k');
  if (format === 'opus') args.push('-c:a', 'libopus', '-b:a', '128k');
  args.push(output);
  const r = await runFFmpeg(args);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

/** 混音：多音频 → 一个 */
export async function mixAudio(
  inputs: string[], output: string, volumes?: number[]
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  if (!inputs.length) return { ok: false, error: '没有输入文件' };
  const args: string[] = ['-y'];
  for (const i of inputs) args.push('-i', i);
  const n = inputs.length;
  const vols = (volumes || inputs.map(() => 1)).map(v => (v ?? 1).toFixed(2)).join(' ');
  const labels = inputs.map((_, i) => `[${i}:a]`).join('');
  args.push('-filter_complex', `${labels}amix=inputs=${n}:duration=longest:weights=${vols}[a]`,
    '-map', '[a]', output);
  const r = await runFFmpeg(args);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

/** 响度归一（EBU R128，短视频平台标准 -14 LUFS） */
export async function normalizeAudio(
  input: string, output: string, lufs = -14
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  const r = await runFFmpeg([
    '-y', '-i', input,
    '-af', `loudnorm=I=${lufs}:TP=-1.5:LRA=11`,
    output,
  ]);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

/* ---------------- 图片操作 ---------------- */
export async function convertImage(
  input: string, output: string,
  opts?: { width?: number; height?: number; quality?: number; rotate?: number }
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  const filters: string[] = [];
  if (opts?.width || opts?.height) filters.push(`scale=${opts.width || -1}:${opts.height || -1}`);
  if (opts?.rotate) filters.push(`rotate=${opts.rotate * Math.PI / 180}:ow=rotw(iw):oh=roth(ih)`);
  const args = ['-y', '-i', input];
  if (filters.length) args.push('-vf', filters.join(','));
  const q = opts?.quality ?? 90;
  if (/\.jpe?g$/i.test(output)) args.push('-q:v', String(Math.max(1, Math.round((100 - q) / 9))));
  if (/\.webp$/i.test(output)) args.push('-quality', String(q));
  args.push(output);
  const r = await runFFmpeg(args);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

/** 拼图：多图 → 一张（grid 布局） */
export async function makeGrid(
  inputs: string[], output: string, cols = 2, cellW = 480
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  if (!inputs.length) return { ok: false, error: '没有输入图片' };
  const args: string[] = ['-y'];
  for (const i of inputs) args.push('-i', i);
  const rows = Math.ceil(inputs.length / cols);
  const idx = inputs.map((_, i) => `[${i}:v]scale=${cellW}:-1,setsar=1[t${i}]`).join(';');
  const streams = inputs.map((_, i) => `[t${i}]`).join('');
  args.push('-filter_complex',
    `${idx};${streams}xstack=inputs=${inputs.length}:layout=${gridLayout(inputs.length, cols, rows)}[out]`,
    '-map', '[out]', output);
  const r = await runFFmpeg(args);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

function gridLayout(n: number, cols: number, rows: number): string {
  const parts: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = i % cols, r = Math.floor(i / cols);
    parts.push(`${c * 1}_${r * 1}`);
  }
  return parts.join('|');
}

/** 视频转 GIF */
export async function videoToGif(
  input: string, output: string, width = 480, fps = 12
): Promise<{ ok: boolean; output?: string; error?: string }> {
  if (!FFMPEG) return { ok: false, error: 'ffmpeg 不可用' };
  const r = await runFFmpeg([
    '-y', '-i', input,
    '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse=dither=bayer`,
    '-loop', '0', output,
  ]);
  return { ok: r.ok, output: r.ok ? output : undefined, error: r.error };
}

/* ---------------- 字幕 ---------------- */
export interface SrtEntry { start: number; end: number; text: string; }

export function parseSrt(content: string): SrtEntry[] {
  const out: SrtEntry[] = [];
  const blocks = content.split(/\r?\n\r?\n/);
  const tc = (s: string) => {
    const m = s.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return 0;
    return +m[1] * 3600 + +m[2] * 60 + +m[3] + (+m[4] || 0) / 1000;
  };
  for (const b of blocks) {
    const lines = b.trim().split(/\r?\n/);
    if (lines.length < 2) continue;
    const tl = lines.find(l => l.includes('-->'));
    if (!tl) continue;
    const [a, z] = tl.split('-->');
    out.push({ start: tc(a), end: tc(z), text: lines.slice(lines.indexOf(tl) + 1).join(' ') });
  }
  return out;
}

export function buildSrt(entries: SrtEntry[]): string {
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  return entries.map((e, i) =>
    `${i + 1}\n${fmt(e.start)} --> ${fmt(e.end)}\n${e.text}\n`).join('\n');
}

/* ---------------- 文档读取（用于 AI 分析） ---------------- */
export async function readDocument(file: string): Promise<{ ok: boolean; text?: string; error?: string }> {
  const kind = classify(file);
  const ext = extname(file).slice(1).toLowerCase();
  try {
    if (kind === 'document') {
      if (ext === 'pdf') {
        const pdf = require('pdf-parse');
        const buf = readFileSync(file);
        const r = await pdf(buf);
        return { ok: true, text: r.text };
      }
      if (ext === 'docx') {
        const mammoth = require('mammoth');
        const r = await mammoth.extractRawText({ path: file });
        return { ok: true, text: r.value };
      }
      // 纯文本类
      const buf = readFileSync(file);
      if (buf[0] === 0xff && buf[1] === 0xfe) return { ok: true, text: buf.toString('utf16le') };
      if (buf[0] === 0xef && buf[1] === 0xbb) return { ok: true, text: buf.slice(3).toString('utf8') };
      return { ok: true, text: buf.toString('utf8') };
    }
    if (kind === 'code') {
      return { ok: true, text: readFileSync(file, 'utf8') };
    }
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
  return { ok: false, error: `暂不支持读取该格式（.${ext}）` };
}
