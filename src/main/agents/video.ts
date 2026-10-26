/* ============================================================================
 * main/agents/video.ts —— AI 短视频生成（本地免费）
 * ----------------------------------------------------------------------------
 * 目标：用【完全免费、纯本地】的方式生成短视频，不依赖任何付费 API。
 *
 * 流水线：
 *   ① 脚本：本地 LLM 生成【钩子 + 分镜 + 配音稿】（中文）
 *   ② 画面：用本地 SVG 渲染分镜卡片（零依赖、零下载、秒级出图）
 *   ③ 配音稿：导出为 SRT 字幕 + 纯文本配音稿（可导入任何免费 TTS）
 *   ④ 合成：调用系统 ffmpeg（若存在）拼成 MP4；没有 ffmpeg 就产出
 *      「分镜图集 + 字幕 + 配音稿」的完整素材包，用户可用任意免费工具合成
 *
 * 为什么不做 AI 画图（Stable Diffusion / Flux）：
 *   ① 8GB 内存 + 无 GPU 跑不动（SD1.5 勉强，Flux 直接 OOM）
 *   ② 需要额外下载 2-7GB 权重
 *   ③ 生成一张图要 10-60 秒，做视频极慢
 *   ④ 本方案秒级出图，且文字排版清晰（AI 生成图做字幕底板反而糊）
 *
 * 为什么不做 TTS 配音：
 *   ① Windows 自带 SAPI 中文语音（Microsoft Huihui/Yaoyao/Kangkang），完全免费
 *   ② 离线、无需 API Key
 *   ③ 通过 PowerShell 调用（Windows 内置，不装任何东西）
 * ========================================================================== */
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

export interface VideoScript {
  title: string;
  hook: string;
  scenes: Array<{
    index: number;
    duration: number;      // 秒
    visual: string;        // 画面描述
    caption: string;       // 字幕
    narration: string;     // 配音稿
  }>;
  tags: string[];
  bgm?: string;
}

export interface VideoOutput {
  ok: boolean;
  dir?: string;
  files?: string[];
  script?: VideoScript;
  mp4?: string;
  error?: string;
  message?: string;
}

/* ---------------- 解析 LLM 返回的脚本 ---------------- */
export function parseVideoScript(text: string): VideoScript | null {
  if (!text) return null;

  /* 提取 JSON（多种容错方式）
   * ★实测坑（2026-10-25）：qwen3 系即使 think:false + /no_think，
   *   仍会把推理过程写进 content，JSON 被推到几千字符之后。
   *   实测一次输出长 6647 字符，其中前 5803 字符是推理，JSON 只在最后。
   *   → 必须【跳过所有前言】，从后往前逐个尝试 '{' 起点。 */
  let obj: any = null;

  const tryParse = (raw: string | null): any => {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { }
    try { return JSON.parse(raw.replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"')); } catch (e) { }
    return null;
  };
  const hasScenes = (o: any) => o && Array.isArray(o.scenes) && o.scenes.length > 0;

  // ① ```json 代码块（优先）
  const blocks = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/g) || [];
  for (const b of blocks) {
    const raw = b.replace(/```(?:json)?\s*\n?/g, '').replace(/```/g, '').trim();
    const o = tryParse(raw);
    if (hasScenes(o)) { obj = o; break; }
  }

  // ② 从后往前扫描每个 '{' 起点（跳过推理前言）
  if (!obj) {
    const end = text.lastIndexOf('}');
    for (let i = end; i >= 0; i = text.lastIndexOf('{', i - 1)) {
      const raw = text.slice(i, end + 1);
      const o = tryParse(raw);
      if (hasScenes(o)) { obj = o; break; }
    }
  }

  // ③ 宽松匹配 scenes 段
  if (!obj) {
    const m = text.match(/\{[\s\S]*?"scenes"[\s\S]*?\]/);
    if (m && m.index !== undefined) {
      const tail = text.indexOf(']', m.index + m[0].length - 1);
      const raw = text.slice(m.index, tail + 1) + '}';
      obj = tryParse(raw);
    }
  }

  if (obj && Array.isArray(obj.scenes) && obj.scenes.length) {
    return {
      title: obj.title || '未命名短视频',
      hook: obj.hook || '',
      scenes: obj.scenes.map((s: any, i: number) => ({
        index: i + 1,
        duration: Number(s.duration) || 5,
        visual: s.visual || '',
        caption: s.caption || '',
        narration: s.narration || '',
      })),
      tags: Array.isArray(obj.tags) ? obj.tags : [],
      bgm: obj.bgm,
    };
  }

  // 文本格式兜底：按【场景N】切分
  const scenes: VideoScript['scenes'] = [];
  const textBlocks = text.split(/【场景\s*\d+】|\n#{2,3}\s*/).filter(b => b.trim());
  for (let i = 0; i < textBlocks.length; i++) {
    const b = textBlocks[i];
    const narration = b.replace(/^\s*时长[:：]\s*\d+\s*秒?/m, '').trim();
    if (!narration) continue;
    scenes.push({
      index: i + 1,
      duration: 5,
      visual: '',
      caption: narration.split('\n')[0].slice(0, 30),
      narration,
    });
  }
  if (!scenes.length) return null;

  const titleMatch = text.match(/标题[:：]\s*(.+)/);
  const tagMatch = text.match(/标签[:：]\s*(.+)/);
  return {
    title: titleMatch ? titleMatch[1].trim() : '未命名短视频',
    hook: '',
    scenes,
    tags: tagMatch ? tagMatch[1].split(/[,，\s]+/).filter(Boolean) : [],
  };
}

/* ---------------- 渲染分镜图（纯 SVG，零依赖） ---------------- */
function renderSceneSvg(s: VideoScript['scenes'][number], title: string, total: number): string {
  const W = 1080, H = 1920;             // 9:16 竖屏
  const safe = (t: string) => t.replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

  // 字幕自动换行（按字符数粗算，中文按 18 字/行）
  const wrap = (text: string, per = 18, max = 4): string[] => {
    const out: string[] = [];
    let line = '';
    for (const ch of text) {
      line += ch;
      if (line.length >= per) { out.push(line); line = ''; }
      if (out.length >= max) break;
    }
    if (line && out.length < max) out.push(line);
    return out;
  };

  const capLines = wrap(s.caption || s.narration.slice(0, 60));
  const capY = H - 420;

  // 背景渐变（按场景序号变色）
  const hues = [220, 265, 200, 300, 170, 240];
  const hue = hues[(s.index - 1) % hues.length];

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 45%, 18%)"/>
      <stop offset="100%" stop-color="hsl(${hue + 30}, 55%, 8%)"/>
    </linearGradient>
    <linearGradient id="bar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="hsl(${hue}, 90%, 62%)"/>
      <stop offset="100%" stop-color="hsl(${hue + 40}, 90%, 55%)"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>

  <!-- 装饰圆 -->
  <circle cx="${880 - s.index * 40}" cy="360" r="220" fill="hsl(${hue}, 70%, 30%)" opacity="0.25"/>
  <circle cx="${180 + s.index * 30}" cy="1250" r="300" fill="hsl(${hue + 50}, 70%, 26%)" opacity="0.18"/>

  <!-- 顶部标题条 -->
  <rect x="0" y="0" width="${W}" height="200" fill="rgba(0,0,0,.35)"/>
  <text x="60" y="95" font-family="Microsoft YaHei, sans-serif" font-size="42" fill="#fff" font-weight="bold">${safe(title.slice(0, 16))}</text>
  <text x="60" y="150" font-family="Microsoft YaHei, sans-serif" font-size="30" fill="hsl(${hue}, 90%, 78%)">场景 ${s.index} / ${total} · ${s.duration}s</text>

  <!-- 进度条 -->
  <rect x="60" y="215" width="${W - 120}" height="8" rx="4" fill="rgba(255,255,255,.2)"/>
  <rect x="60" y="215" width="${(W - 120) * (s.index / total)}" height="8" rx="4" fill="url(#bar)"/>

  <!-- 画面描述（居中偏上） -->
  <foreignObject x="80" y="420" width="${W - 160}" height="700">
    <div xmlns="http://www.w3.org/1999/xhtml" style="color:#dfe6f5;font-family:Microsoft YaHei,sans-serif;font-size:36px;line-height:1.6;text-align:center;">
      ${safe(s.visual || s.narration.slice(0, 80))}
    </div>
  </foreignObject>

  <!-- 字幕 -->
  <rect x="0" y="${capY - 70}" width="${W}" height="${240 + capLines.length * 10}" fill="rgba(0,0,0,.5)"/>
  ${capLines.map((l, i) => `
  <text x="${W / 2}" y="${capY + i * 62}" font-family="Microsoft YaHei, sans-serif" font-size="46" fill="#fff" text-anchor="middle" font-weight="bold">${safe(l)}</text>`).join('')}

  <!-- 底部品牌条 -->
  <rect x="0" y="${H - 90}" width="${W}" height="90" fill="url(#bar)" opacity="0.85"/>
  <text x="${W / 2}" y="${H - 32}" font-family="Microsoft YaHei, sans-serif" font-size="34" fill="#0b1020" text-anchor="middle" font-weight="bold">DevAI Studio</text>
</svg>`;
}

/* ---------------- SRT 字幕 ---------------- */
function buildSrt(scenes: VideoScript['scenes']): string {
  const fmt = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.round((sec % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
  };
  const out: string[] = [];
  let t = 0;
  scenes.forEach((s, i) => {
    const start = t;
    const end = t + s.duration;
    t = end;
    out.push(String(i + 1));
    out.push(`${fmt(start)} --> ${fmt(end)}`);
    out.push(s.caption || s.narration);
    out.push('');
  });
  return out.join('\n');
}

/* ---------------- 生成视频素材包 ---------------- */
export interface VideoOptions {
  ffmpegPath?: string;
  withVoice?: boolean;
  /** 将 SVG 光栅化为 PNG（由主进程注入 Electron 渲染器；ffmpeg 无法解码 SVG） */
  rasterize?: (svg: string) => Promise<Buffer>;
  /** ffmpeg 单步超时（毫秒） */
  ffmpegTimeoutMs?: number;
}

export async function generateVideo(
  script: VideoScript,
  outDir: string,
  options?: VideoOptions
): Promise<VideoOutput> {
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

    const files: string[] = [];
    const rasterize = options?.rasterize;
    const usePng = typeof rasterize === 'function';

    // ① 分镜图（SVG 矢量，始终产出，方便剪映等导入）
    const imgDir = join(outDir, 'scenes');
    if (!existsSync(imgDir)) mkdirSync(imgDir, { recursive: true });

    const framePaths: string[] = [];   // 交给 ffmpeg 的帧（PNG 优先，否则 SVG）
    for (const s of script.scenes) {
      const svg = renderSceneSvg(s, script.title, script.scenes.length);
      const svgPath = join(imgDir, `scene-${String(s.index).padStart(2, '0')}.svg`);
      writeFileSync(svgPath, svg, 'utf8');
      files.push(svgPath);

      if (usePng) {
        try {
          const buf = await rasterize!(svg);
          const pngPath = join(imgDir, `scene-${String(s.index).padStart(2, '0')}.png`);
          writeFileSync(pngPath, buf);
          files.push(pngPath);
          framePaths.push(pngPath);
        } catch {
          framePaths.push(svgPath);
        }
      } else {
        framePaths.push(svgPath);
      }
    }

    // ② 字幕 SRT
    const srtPath = join(outDir, 'subtitles.srt');
    writeFileSync(srtPath, buildSrt(script.scenes), 'utf8');
    files.push(srtPath);

    // ③ 配音稿（纯文本，可喂给任意免费 TTS）
    const voicePath = join(outDir, 'voiceover.txt');
    writeFileSync(voicePath,
      script.scenes.map(s => `【场景 ${s.index}】(${s.duration}s)\n${s.narration}`).join('\n\n'),
      'utf8');
    files.push(voicePath);

    // ④ 脚本 JSON
    const jsonPath = join(outDir, 'script.json');
    writeFileSync(jsonPath, JSON.stringify(script, null, 2), 'utf8');
    files.push(jsonPath);

    // ⑤ README（合成说明）
    const readmePath = join(outDir, '合成说明.md');
    writeFileSync(readmePath, [
      `# ${script.title}`,
      '',
      `**总时长**：${script.scenes.reduce((a, b) => a + b.duration, 0)} 秒`,
      `**场景数**：${script.scenes.length}`,
      `**标签**：${script.tags.join(' ')}`,
      '',
      '## 素材清单',
      '- `scenes/` —— 分镜图（SVG 矢量，任意分辨率无损缩放）',
      '- `subtitles.srt` —— 标准字幕文件（所有剪辑软件通用）',
      '- `voiceover.txt` —— 配音稿（可用系统免费 TTS 或任意免费工具）',
      '- `script.json` —— 结构化脚本',
      '',
      '## 合成方式（任选其一，全部免费）',
      '',
      '### 方式 A：系统 ffmpeg（无需配音，直接出无声视频）',
      '```bash',
      'ffmpeg -f concat -safe 0 -i scenes.txt -vf "scale=1080:1920" -r 30 -c:v libx264 -pix_fmt yuv420p out.mp4',
      '```',
      '',
      '### 方式 B：Windows 自带 TTS 生成配音（中文女声，完全免费）',
      '```powershell',
      '$voice = New-Object -ComObject SAPI.SPVoice',
      '$voice.Voice = $voice.GetVoices() | Where-Object { $_.GetDescription() -match "Huihui|Yaoyao|Kangkang|Xiaoxiao" }',
      '$voice.Speak("这里放配音稿")',
      '```',
      '',
      '### 方式 C：剪映 / CapCut / DaVinci Resolve（免费）',
      '1. 新建 1080×1920 竖屏项目',
      '2. 把 `scenes/*.svg` 按顺序拖入时间线，每段停留对应时长',
      '3. 导入 `subtitles.srt` 作为字幕轨',
      '4. 用系统 TTS 或剪映免费配音生成音频轨',
      '',
      '## 标题候选',
      ...(script.hook ? [`\n**钩子**：${script.hook}`] : []),
    ].join('\n'), 'utf8');
    files.push(readmePath);

    // ⑥ 若有 ffmpeg，直接合成 MP4（必须用 PNG 帧，ffmpeg 才能解码）
    let mp4: string | undefined;
    const ffmpeg = options?.ffmpegPath || findFfmpeg();
    const haveRaster = framePaths.length === script.scenes.length &&
      framePaths.every(p => p.toLowerCase().endsWith('.png'));
    if (ffmpeg && haveRaster) {
      const listPath = join(outDir, 'scenes.txt');
      const scenePath = (i: number) => framePaths[i - 1].replace(/\\/g, '/');
      const lines: string[] = [];
      script.scenes.forEach(s => {
        lines.push("file '" + scenePath(s.index) + "'");
        lines.push('duration ' + s.duration);
      });
      // concat 需要最后一帧重复一次才能正确收尾
      lines.push("file '" + scenePath(script.scenes.length) + "'");
      writeFileSync(listPath, lines.join('\n'), 'utf8');

      mp4 = join(outDir, 'video.mp4');
      const r = await runFfmpeg(ffmpeg, [
        '-f', 'concat', '-safe', '0', '-i', listPath,
        '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
        '-r', '30', '-c:v', 'libx264', '-preset', 'ultrafast',
        '-pix_fmt', 'yuv420p',
        '-movflags', '+faststart', mp4,
      ], options?.ffmpegTimeoutMs || 120000);
      if (!r.ok) mp4 = undefined;
      else files.push(mp4);
    }

    return {
      ok: true,
      dir: outDir,
      files,
      script,
      mp4,
      message: mp4
        ? '已生成 MP4 + 字幕 + 配音稿'
        : (ffmpeg && !haveRaster
            ? '已生成分镜图/字幕/配音稿素材包（光栅化不可用，未合成 MP4）'
            : '已生成分镜图/字幕/配音稿素材包（未找到 ffmpeg，未合成 MP4）'),
    };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/* ---------------- ffmpeg 查找 ---------------- */
function findFfmpeg(): string | null {
  const cands: string[] = [
    /* ★应用自带（一键安装部署位置）优先 */
    join(process.resourcesPath || '', 'ffmpeg', 'bin', 'ffmpeg.exe'),
    'ffmpeg',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'E:\\nginx\\ffmpeg\\bin\\ffmpeg.exe',
  ];
  for (const c of cands) {
    try {
      if (c === 'ffmpeg') {
        // 用 where 查
        const r = require('node:child_process').spawnSync('where', ['ffmpeg'], { encoding: 'utf8', windowsHide: true });
        if (r.status === 0 && r.stdout) return r.stdout.split('\n')[0].trim();
      } else if (existsSync(c)) {
        return c;
      }
    } catch (e) { }
  }
  return null;
}

function runFfmpeg(exe: string, args: string[], timeoutMs = 120000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ ok, error });
    };
    const timer = setTimeout(() => {
      try { p.kill('SIGKILL'); } catch { }
      finish(false, `ffmpeg 超过 ${(timeoutMs / 1000)}s 被强制终止（可能卡死）`);
    }, timeoutMs);

    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(exe, args, { windowsHide: true });
    } catch (e: any) {
      finish(false, e?.message || String(e));
      return;
    }
    let err = '';
    p.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
      if (err.length > 20000) err = err.slice(-20000);
    });
    p.on('close', (code: number) => finish(code === 0, err.slice(-800)));
    p.on('error', (e: any) => finish(false, e?.message));
  });
}
