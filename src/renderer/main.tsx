import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

/* ★黑屏诊断（2026-10-26）：把渲染层 JS 顶层错误/未捕获 Promise 重定向到 console.error，
 * 主进程已监听 console-message 落盘到 render-error.log，避免黑屏零线索。 */
window.addEventListener('error', (e) => {
  console.error('[window.onerror]', e.message, '\n  at', e.filename, ':', e.lineno + ':' + e.colno);
  return false;
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[unhandledrejection]', e.reason);
});

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
} else {
  console.error('[main] 找不到 #root 节点，React 无法挂载（可能 index.html 结构异常）');
}
