/* ============================================================================
 * renderer/components/ThemePicker.tsx —— 风格（主题）切换器
 * ----------------------------------------------------------------------------
 * 用户需求（2026-10-25）："还可以切换风格等"
 * 6 套内置主题，零重载切换（CSS 变量），选择持久化到 localStorage。
 * ========================================================================== */
import React, { useEffect, useState } from 'react';
import { THEMES, getCurrentTheme, applyTheme, Theme } from '../lib/theme';

export default function ThemePicker({ compact }: { compact?: boolean }) {
  const [cur, setCur] = useState<Theme>(getCurrentTheme());

  useEffect(() => {
    setCur(getCurrentTheme());
  }, []);

  const pick = (t: Theme) => {
    applyTheme(t);
    setCur(t);
  };

  if (compact) {
    return (
      <button
        className="theme-btn"
        title={`当前风格：${cur.name}（点击切换）`}
        onClick={() => {
          const i = THEMES.findIndex(t => t.id === cur.id);
          const next = THEMES[(i + 1) % THEMES.length];
          pick(next);
        }}
      >
        {cur.icon} {cur.name}
      </button>
    );
  }

  return (
    <div className="theme-picker">
      <div className="mem-sec-title">🎨 界面风格</div>
      <div className="theme-grid">
        {THEMES.map(t => (
          <button
            key={t.id}
            className={`theme-card ${cur.id === t.id ? 'on' : ''}`}
            onClick={() => pick(t)}
          >
            <div className="theme-preview" style={themePreviewStyle(t)}>
              <span className="tp-bar" />
              <span className="tp-block" />
              <span className="tp-line" />
              <span className="tp-dot" />
            </div>
            <div className="theme-name">{t.icon} {t.name}</div>
            <div className="theme-desc">{t.desc}</div>
            {cur.id === t.id && <div className="theme-check">✓ 当前</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

/** 用主题变量渲染预览缩略图 */
function themePreviewStyle(t: Theme): React.CSSProperties {
  return {
    background: t.vars['--bg-1'],
    borderColor: t.vars['--line'],
  } as React.CSSProperties;
}
