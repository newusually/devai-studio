/* ============================================================================
 * main/engines/templates.ts —— 分镜模板库 + 剪映风格合成参数
 * ----------------------------------------------------------------------------
 * 用户需求（2026-10-25）："要求下载多个视频场景 还有各种剪映 即梦等功能"
 *
 * 设计：
 *   ① 多套【分镜模板】—— 同一脚本可套不同视觉风格，产出多个版本
 *   ② 剪映风格【时间线】—— 轨道、字幕样式、转场、片头片尾、BGM、滤镜
 *   ③ 特效参数 —— 缩放/平移（Ken Burns）、渐入渐出、抖动、变装转场
 *
 * 全部本地实现（SVG 渲染 + ffmpeg 滤镜），零 API、零成本。
 * ========================================================================== */

/* ---------------- 分镜模板（视觉风格） ---------------- */
export interface SceneTemplate {
  id: string;
  name: string;
  icon: string;
  desc: string;
  /** 背景渐变色对 */
  palette: [string, string];
  /** 强调色 */
  accent: string;
  /** 文字色 */
  fg: string;
  /** 装饰形状类型 */
  decor: 'blob' | 'grid' | 'rings' | 'wave' | 'minimal';
  /** 字幕位置（0~1，垂直比例） */
  captionY: number;
  /** 标题样式 */
  titleStyle: 'bold-left' | 'center' | 'badge';
  /** 品牌条 */
  brandBar: boolean;
  /** 顶部进度条 */
  progressBar: boolean;
}

export const TEMPLATES: SceneTemplate[] = [
  {
    id: 'tech', name: '科技蓝', icon: '🛠', desc: '深蓝渐变 · 网格装饰 · 适合技术科普',
    palette: ['#0b1220', '#12294a'], accent: '#4d8dff', fg: '#e8f0ff',
    decor: 'grid', captionY: 0.76, titleStyle: 'bold-left', brandBar: true, progressBar: true,
  },
  {
    id: 'sunset', name: '落日橙', icon: '🌅', desc: '暖橙渐变 · 光斑装饰 · 适合生活情感',
    palette: ['#2b1206', '#7a2f0e'], accent: '#ff8c42', fg: '#fff2e6',
    decor: 'blob', captionY: 0.74, titleStyle: 'center', brandBar: true, progressBar: true,
  },
  {
    id: 'mint', name: '薄荷绿', icon: '🍃', desc: '清透绿 · 圆环装饰 · 适合健康生活',
    palette: ['#06231d', '#0d4438'], accent: '#2ee6a8', fg: '#e6fff6',
    decor: 'rings', captionY: 0.75, titleStyle: 'bold-left', brandBar: true, progressBar: false,
  },
  {
    id: 'neon', name: '霓虹紫', icon: '🌆', desc: '赛博紫 · 波形装饰 · 适合游戏二次元',
    palette: ['#160a2b', '#3d1263'], accent: '#b06bff', fg: '#f3e8ff',
    decor: 'wave', captionY: 0.73, titleStyle: 'badge', brandBar: true, progressBar: true,
  },
  {
    id: 'mono', name: '极简黑白', icon: '◼', desc: '纯黑白 · 无装饰 · 适合知识干货',
    palette: ['#0a0a0a', '#1c1c1c'], accent: '#ffffff', fg: '#f0f0f0',
    decor: 'minimal', captionY: 0.78, titleStyle: 'bold-left', brandBar: false, progressBar: true,
  },
  {
    id: 'paper', name: '纸质米色', icon: '📄', desc: '米白暖色 · 适合教程知识类',
    palette: ['#f5f0e6', '#e6dcc8'], accent: '#b07d3f', fg: '#2b2418',
    decor: 'minimal', captionY: 0.77, titleStyle: 'center', brandBar: false, progressBar: true,
  },
  {
    id: 'candy', name: '糖果粉', icon: '🍬', desc: '粉紫渐变 · 适合美妆穿搭',
    palette: ['#2b0d20', '#6b1f4d'], accent: '#ff6b9d', fg: '#ffeef5',
    decor: 'blob', captionY: 0.74, titleStyle: 'center', brandBar: true, progressBar: false,
  },
  {
    id: 'ocean', name: '深海蓝', icon: '🌊', desc: '深海渐变 · 波纹装饰 · 适合科普纪录',
    palette: ['#03131f', '#0a3350'], accent: '#22c1e8', fg: '#e2f7ff',
    decor: 'wave', captionY: 0.76, titleStyle: 'bold-left', brandBar: true, progressBar: true,
  },
];

export function getTemplate(id: string): SceneTemplate {
  return TEMPLATES.find(t => t.id === id) || TEMPLATES[0];
}

/* ---------------- 剪映风格：时间线 ---------------- */
export interface TimelineClip {
  /** 素材路径 */
  path: string;
  /** 在时间线上的开始秒 */
  start: number;
  /** 时长秒 */
  duration: number;
  kind: 'video' | 'image' | 'audio' | 'text' | 'subtitle';
  /** 转场 */
  transition?: 'none' | 'fade' | 'slideleft' | 'slideright' | 'whip' | 'zoom' | 'dissolve';
  /** 音效 */
  sfx?: string;
  /** 音量 0-2 */
  volume?: number;
  /** 缩放动画（Ken Burns） */
  kenBurns?: 'in' | 'out' | 'none';
}

export interface TimelineTrack {
  name: string;
  type: 'video' | 'audio' | 'text';
  muted?: boolean;
  clips: TimelineClip[];
}

export interface Timeline {
  duration: number;
  ratio: '9:16' | '16:9' | '1:1' | '4:5';
  fps: number;
  tracks: TimelineTrack[];
  /** 全局滤镜 */
  filter?: string;
  /** 背景音乐 */
  bgm?: { path: string; volume: number; fadeIn?: number; fadeOut?: number };
  /** 片头 */
  intro?: { duration: number; text: string };
  /** 片尾 */
  outro?: { duration: number; text: string };
  /** 字幕样式 */
  subtitleStyle?: SubtitleStyle;
}

export interface SubtitleStyle {
  fontSize: number;
  fontColor: string;
  strokeColor: string;
  strokeWidth: number;
  bgColor: string;
  bgOpacity: number;
  position: 'top' | 'center' | 'bottom';
  /** 逐字高亮 */
  highlight?: boolean;
  highlightColor?: string;
}

/* ---------------- 字幕样式预设（剪映风格） ---------------- */
export const SUBTITLE_STYLES: Array<{ id: string; name: string; icon: string; style: SubtitleStyle }> = [
  {
    id: 'bold-white', name: '白字粗描边', icon: '⬜',
    style: { fontSize: 46, fontColor: '#FFFFFF', strokeColor: '#000000', strokeWidth: 3, bgColor: '#000000', bgOpacity: 0, position: 'bottom' },
  },
  {
    id: 'douyin-yellow', name: '抖音黄字', icon: '🟡',
    style: { fontSize: 48, fontColor: '#FFE44D', strokeColor: '#000000', strokeWidth: 3, bgColor: '#000000', bgOpacity: 0, position: 'bottom' },
  },
  {
    id: 'box', name: '底框白字', icon: '▭',
    style: { fontSize: 42, fontColor: '#FFFFFF', strokeColor: '#000000', strokeWidth: 0, bgColor: '#000000', bgOpacity: 0.72, position: 'bottom' },
  },
  {
    id: 'top-card', name: '顶部卡片', icon: '▤',
    style: { fontSize: 38, fontColor: '#1A1D24', strokeColor: '#FFFFFF', strokeWidth: 0, bgColor: '#FFD24D', bgOpacity: 0.92, position: 'top' },
  },
  {
    id: 'pink-pop', name: '少女粉字', icon: '🌸',
    style: { fontSize: 46, fontColor: '#FF6B9D', strokeColor: '#FFFFFF', strokeWidth: 2, bgColor: '#000000', bgOpacity: 0, position: 'bottom', highlight: true, highlightColor: '#FFE44D' },
  },
  {
    id: 'green-mono', name: '绿色终端', icon: '💻',
    style: { fontSize: 40, fontColor: '#39FF14', strokeColor: '#000000', strokeWidth: 2, bgColor: '#000000', bgOpacity: 0, position: 'bottom' },
  },
];

export function getSubtitleStyle(id: string): SubtitleStyle {
  return (SUBTITLE_STYLES.find(s => s.id === id) || SUBTITLE_STYLES[0]).style;
}

/* ---------------- ffmpeg 滤镜生成 ---------------- */
export function buildVideoFilter(tl: Timeline, template: SceneTemplate): string[] {
  const filters: string[] = [];
  const W = tl.ratio === '16:9' ? 1920 : tl.ratio === '1:1' ? 1080 : tl.ratio === '4:5' ? 1080 : 1080;
  const H = tl.ratio === '16:9' ? 1080 : tl.ratio === '1:1' ? 1080 : tl.ratio === '4:5' ? 1350 : 1920;

  filters.push(`scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2`);

  // Ken Burns：缓慢缩放/平移（剪映常用）
  const videoTrack = tl.tracks.find(t => t.type === 'video');
  const kb = videoTrack?.clips.find(c => c.kenBurns && c.kenBurns !== 'none');
  if (kb) {
    if (kb.kenBurns === 'in') {
      filters.push(`zoompan=z='min(zoom+0.0012,1.25)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${tl.fps}`);
    } else if (kb.kenBurns === 'out') {
      filters.push(`zoompan=z='if(lte(zoom,1.0),1.25,max(1.001,zoom-0.0012))':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${tl.fps}`);
    }
  }

  // 全局滤镜
  if (tl.filter) filters.push(tl.filter);

  return filters;
}

/** 转场 → ffmpeg xfade 参数 */
export function transitionParams(transition: string, offset: number, dur: number): string[] | null {
  switch (transition) {
    case 'fade': return ['fade', `t=in:st=${offset}:d=${dur}`];
    case 'dissolve': return ['dissolve', `t=${offset}:d=${dur}`];
    case 'slideleft': return ['slideleft', `t=${offset}:d=${dur}`];
    case 'slideright': return ['slideright', `t=${offset}:d=${dur}`];
    case 'whip': return ['whip', `t=${offset}:d=${dur}`];
    case 'zoom': return ['zoomin', `t=${offset}:d=${dur}`];
    default: return null;
  }
}

/** 字幕样式 → ffmpeg subtitles filter 的 force_style */
export function subtitleForceStyle(st: SubtitleStyle): string {
  const parts = [
    `FontSize=${Math.round(st.fontSize / 12)}`,   // ASS 字号基准与像素换算
    `PrimaryColour=&H00${hexToBgr(st.fontColor)}`,
    `OutlineColour=&H00${hexToBgr(st.strokeColor)}`,
    `BorderStyle=${st.bgOpacity > 0 ? 3 : 1}`,
    `Outline=${st.strokeWidth}`,
    `Shadow=0`,
    `BackColour=&H${st.bgOpacity > 0 ? '80' : '00'}${hexToBgr(st.bgColor)}`,
    `Alignment=${st.position === 'top' ? 8 : st.position === 'center' ? 5 : 2}`,
    `Bold=1`,
  ];
  return parts.join(',');
}

function hexToBgr(hex: string): string {
  const h = (hex || '#FFFFFF').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = full.slice(0, 2), g = full.slice(2, 4), b = full.slice(4, 6);
  return (b + g + r).toUpperCase();
}

/* ---------------- 场景 SVG 渲染（多模板） ---------------- */
export function renderSceneSvgTpl(
  scene: { index: number; duration: number; visual: string; caption: string; narration: string },
  title: string,
  total: number,
  tpl: SceneTemplate,
  sub: SubtitleStyle
): string {
  const W = 1080, H = 1920;
  const esc = (s: string) => (s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c] as string));

  const wrap = (text: string, per = 17, max = 4): string[] => {
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

  const capLines = wrap(scene.caption || scene.narration.slice(0, 60));
  const capY = Math.round(H * tpl.captionY);

  // 装饰
  let decor = '';
  if (tpl.decor === 'grid') {
    decor = `<g opacity="0.07">${Array.from({ length: 12 }, (_, i) =>
      `<line x1="${i * 90}" y1="0" x2="${i * 90}" y2="${H}" stroke="${tpl.accent}" stroke-width="1"/>`).join('')}
      ${Array.from({ length: 22 }, (_, i) =>
        `<line x1="0" y1="${i * 90}" x2="${W}" y2="${i * 90}" stroke="${tpl.accent}" stroke-width="1"/>`).join('')}</g>`;
  } else if (tpl.decor === 'blob') {
    decor = `<circle cx="${860 - scene.index * 45}" cy="380" r="240" fill="${tpl.accent}" opacity="0.16"/>
             <circle cx="${190 + scene.index * 35}" cy="1280" r="320" fill="${tpl.accent}" opacity="0.11"/>
             <circle cx="540" cy="760" r="150" fill="${tpl.accent}" opacity="0.08"/>`;
  } else if (tpl.decor === 'rings') {
    decor = Array.from({ length: 5 }, (_, i) =>
      `<circle cx="${200 + i * 60}" cy="${500 + i * 90}" r="${70 + i * 46}" fill="none" stroke="${tpl.accent}" stroke-width="2" opacity="${0.22 - i * 0.03}"/>`).join('');
  } else if (tpl.decor === 'wave') {
    const pts = Array.from({ length: 14 }, (_, i) =>
      `${i * 82},${900 + Math.sin(i * 0.9 + scene.index) * 120}`).join(' ');
    decor = `<polyline points="${pts}" fill="none" stroke="${tpl.accent}" stroke-width="4" opacity="0.22"/>
             <polyline points="${pts}" fill="none" stroke="${tpl.accent}" stroke-width="14" opacity="0.07" transform="translate(0,40)"/>`;
  }

  // 标题样式
  let titleHtml = '';
  if (tpl.titleStyle === 'bold-left') {
    titleHtml = `<rect x="60" y="150" width="7" height="62" fill="${tpl.accent}"/>
      <text x="86" y="196" font-family="Microsoft YaHei,sans-serif" font-size="42" fill="${tpl.fg}" font-weight="bold">${esc(title.slice(0, 15))}</text>`;
  } else if (tpl.titleStyle === 'center') {
    titleHtml = `<text x="${W / 2}" y="185" font-family="Microsoft YaHei,sans-serif" font-size="44" fill="${tpl.fg}" font-weight="bold" text-anchor="middle">${esc(title.slice(0, 15))}</text>`;
  } else {
    titleHtml = `<rect x="${W / 2 - 210}" y="140" width="420" height="70" rx="14" fill="${tpl.accent}" opacity="0.9"/>
      <text x="${W / 2}" y="190" font-family="Microsoft YaHei,sans-serif" font-size="38" fill="#0b1020" font-weight="bold" text-anchor="middle">${esc(title.slice(0, 13))}</text>`;
  }

  // 字幕
  const subBg = sub.bgOpacity > 0
    ? `<rect x="90" y="${capY - 56}" width="${W - 180}" height="${capLines.length * 62 + 44}" rx="12" fill="${sub.bgColor}" opacity="${sub.bgOpacity}"/>`
    : '';
  const subStroke = sub.strokeWidth > 0
    ? ` stroke="${sub.strokeColor}" stroke-width="${sub.strokeWidth}" paint-order="stroke"`
    : '';
  const capHtml = capLines.map((l, i) =>
    `<text x="${W / 2}" y="${capY + i * 62}" font-family="Microsoft YaHei,sans-serif" font-size="${sub.fontSize}" fill="${sub.fontColor}" text-anchor="middle" font-weight="bold"${subStroke}>${esc(l)}</text>`).join('');

  const progress = tpl.progressBar
    ? `<rect x="60" y="245" width="${W - 120}" height="8" rx="4" fill="rgba(255,255,255,.18)"/>
       <rect x="60" y="245" width="${(W - 120) * (scene.index / total)}" height="8" rx="4" fill="${tpl.accent}"/>`
    : '';

  const brand = tpl.brandBar
    ? `<rect x="0" y="${H - 86}" width="${W}" height="86" fill="${tpl.accent}" opacity="0.85"/>
       <text x="${W / 2}" y="${H - 28}" font-family="Microsoft YaHei,sans-serif" font-size="32" fill="#0b1020" text-anchor="middle" font-weight="bold">DevAI Studio</text>`
    : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${tpl.palette[0]}"/>
      <stop offset="100%" stop-color="${tpl.palette[1]}"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
  ${decor}
  ${titleHtml}
  ${progress}
  <text x="${W / 2}" y="470" font-family="Microsoft YaHei,sans-serif" font-size="34" fill="${tpl.fg}" text-anchor="middle" opacity="0.9">${esc(scene.visual.slice(0, 46))}</text>
  ${subBg}
  ${capHtml}
  ${brand}
  <text x="${W - 70}" y="120" font-family="Microsoft YaHei,sans-serif" font-size="26" fill="${tpl.accent}" text-anchor="end" opacity="0.85">${scene.index}/${total} · ${scene.duration}s</text>
</svg>`;
}
