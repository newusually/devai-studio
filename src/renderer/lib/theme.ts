/* ============================================================================
 * renderer/lib/theme.ts —— 主题（风格）系统
 * ----------------------------------------------------------------------------
 * 用户需求（2026-10-25）："还可以切换风格等"
 *
 * 提供 6 套内置主题 + 自定义 CSS 变量覆盖：
 *   深空（默认深色）/ 极光 / 暗夜橙 / 纸白（浅色）/ 高对比 / 终端绿
 * 主题通过 CSS 变量实现，切换零重载（写 <html data-theme> 属性）。
 * 用户自选配色存 localStorage。
 * ========================================================================== */

export interface Theme {
  id: string;
  name: string;
  icon: string;
  desc: string;
  /** 主题变量（覆盖 global.css 的 :root） */
  vars: Record<string, string>;
}

export const THEMES: Theme[] = [
  {
    id: 'deepspace',
    name: '深空',
    icon: '🌌',
    desc: '默认深色 · 蓝紫渐变 · 长时间 coding 不刺眼',
    vars: {
      '--bg': '#0f1117', '--bg-1': '#151822', '--bg-2': '#1b1f2b', '--bg-3': '#232838',
      '--line': '#2a3040', '--line-2': '#363d51',
      '--txt': '#e6e9f0', '--txt-2': '#9aa3b8', '--txt-3': '#6b7488',
      '--acc': '#4d8dff', '--acc-dim': 'rgba(77,141,255,.14)',
      '--up': '#ff4d4f', '--dn': '#2ecc71', '--warn': '#ffb020',
    },
  },
  {
    id: 'aurora',
    name: '极光',
    icon: '🌈',
    desc: '青紫渐变 · 高饱和 · 视觉冲击强',
    vars: {
      '--bg': '#0b0e1a', '--bg-1': '#12162a', '--bg-2': '#1a1f38', '--bg-3': '#242b4a',
      '--line': '#2e3660', '--line-2': '#3e4878',
      '--txt': '#f0f2ff', '--txt-2': '#a8b0e0', '--txt-3': '#7279b0',
      '--acc': '#00e5c0', '--acc-dim': 'rgba(0,229,192,.15)',
      '--up': '#ff5c8a', '--dn': '#00e5a0', '--warn': '#ffc93c',
    },
  },
  {
    id: 'ember',
    name: '暗夜橙',
    icon: '🔥',
    desc: '暖橙棕调 · 柔和护眼 · 适合夜间',
    vars: {
      '--bg': '#14110f', '--bg-1': '#1c1815', '--bg-2': '#241f1b', '--bg-3': '#2e2721',
      '--line': '#3a312a', '--line-2': '#4a3f34',
      '--txt': '#f2ece5', '--txt-2': '#b8a898', '--txt-3': '#8a7a6c',
      '--acc': '#ff8c42', '--acc-dim': 'rgba(255,140,66,.15)',
      '--up': '#ff6b6b', '--dn': '#7bc96f', '--warn': '#ffc048',
    },
  },
  {
    id: 'paper',
    name: '纸白',
    icon: '📄',
    desc: '浅色护眼 · 白天办公 · 高可读性',
    vars: {
      '--bg': '#f7f8fa', '--bg-1': '#ffffff', '--bg-2': '#f0f2f5', '--bg-3': '#e6e9ee',
      '--line': '#dfe3ea', '--line-2': '#c9cfda',
      '--txt': '#1a1d24', '--txt-2': '#4e5665', '--txt-3': '#7d8695',
      '--acc': '#2f6fed', '--acc-dim': 'rgba(47,111,237,.11)',
      '--up': '#d92d20', '--dn': '#12a150', '--warn': '#dc6803',
    },
  },
  {
    id: 'contrast',
    name: '高对比',
    icon: '⚡',
    desc: '纯黑高对比 · 无障碍友好 · 强边界',
    vars: {
      '--bg': '#000000', '--bg-1': '#0a0a0a', '--bg-2': '#141414', '--bg-3': '#1f1f1f',
      '--line': '#333333', '--line-2': '#4a4a4a',
      '--txt': '#ffffff', '--txt-2': '#d0d0d0', '--txt-3': '#9a9a9a',
      '--acc': '#00b4ff', '--acc-dim': 'rgba(0,180,255,.18)',
      '--up': '#ff5555', '--dn': '#00e676', '--warn': '#ffb300',
    },
  },
  {
    id: 'terminal',
    name: '终端绿',
    icon: '💻',
    desc: '经典黑客终端 · 单色绿 · 极客风',
    vars: {
      '--bg': '#050805', '--bg-1': '#0a100a', '--bg-2': '#0f1a0f', '--bg-3': '#142814',
      '--line': '#1e3a1e', '--line-2': '#2a552a',
      '--txt': '#c8ffc8', '--txt-2': '#7fdc7f', '--txt-3': '#4f9a4f',
      '--acc': '#39ff14', '--acc-dim': 'rgba(57,255,20,.13)',
      '--up': '#ff5555', '--dn': '#39ff14', '--warn': '#ffd700',
    },
  },
];

const STORAGE_KEY = 'devai.theme';

export function getCurrentTheme(): Theme {
  try {
    const id = localStorage.getItem(STORAGE_KEY) || 'deepspace';
    return THEMES.find(t => t.id === id) || THEMES[0];
  } catch (e) {
    return THEMES[0];
  }
}

/** 应用主题（零重载，写 CSS 变量） */
export function applyTheme(t: Theme): void {
  const root = document.documentElement;
  root.setAttribute('data-theme', t.id);
  Object.entries(t.vars).forEach(([k, v]) => {
    root.style.setProperty(k, v);
  });
  try { localStorage.setItem(STORAGE_KEY, t.id); } catch (e) { }
}

/** 切换到下一套主题（循环） */
export function cycleTheme(): Theme {
  const cur = getCurrentTheme();
  const i = THEMES.findIndex(t => t.id === cur.id);
  const next = THEMES[(i + 1) % THEMES.length];
  applyTheme(next);
  return next;
}

/** 恢复默认（清除自定义覆盖） */
export function resetTheme(): Theme {
  const root = document.documentElement;
  THEMES.forEach(t => {
    Object.entries(t.vars).forEach(([k]) => root.style.removeProperty(k));
  });
  const def = THEMES[0];
  try { localStorage.setItem(STORAGE_KEY, def.id); } catch (e) { }
  applyTheme(def);
  return def;
}

/** 初始化（在 App 挂载时调一次） */
export function initTheme(): Theme {
  const t = getCurrentTheme();
  applyTheme(t);
  return t;
}
