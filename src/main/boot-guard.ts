/* ============================================================================
 * main/boot-guard.ts —— 启动自愈：ELECTRON_RUN_AS_NODE 注入防护
 * ----------------------------------------------------------------------------
 * 背景（2026-10-26 实测）：本机 WorkBuddy 等宿主会在自己的进程环境里注入
 *   ELECTRON_RUN_AS_NODE=1
 * 该变量会让 electron.exe **退化成纯 node**（无 GUI、无窗口、require('electron')
 * 只返回一个路径字符串）。实测该构建在 node 模式下连【应用路径参数都会被丢弃】
 * （argv 只剩 exe 本身）→ 入口代码根本不加载 → 秒退 0，无声无息。
 *
 * 因此主防线是 launcher.exe（启动前剥掉该变量，桌面/开始菜单快捷方式都指向它）。
 * 本文件是兜底防线：万一入口真的被加载且检测到退化（例如以脚本方式直跑），
 * 就用剥掉该变量的环境重新拉起自己，避免留下一个假死的 node 进程。
 * ========================================================================== */

/* 退化判定：node 模式下 require('electron') 返回的是可执行文件路径（字符串），
 * 而不是带 app/BrowserWindow 的模块对象。
 * 注意：不能只看 process.versions.electron —— 实测本构建在 node 模式下它仍有值。 */
let degraded = false;
try {
  const electronModule = require('electron');
  degraded = typeof electronModule !== 'object' || electronModule === null || !electronModule.app;
} catch {
  degraded = true;
}

if (degraded) {
  const isChildProcess = process.argv.some(a => a.startsWith('--type='));
  const alreadyRelaunched = process.env.DEVAI_BOOT_RELAUNCH === '1';

  if (!isChildProcess && !alreadyRelaunched) {
    /* 用干净环境重新拉起自己，然后退出这个退化进程 */
    try {
      const { spawn } = require('node:child_process') as typeof import('node:child_process');
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      env.DEVAI_BOOT_RELAUNCH = '1'; // 防递归：重拉后仍异常则不再循环
      const child = spawn(process.execPath, process.argv.slice(1), {
        env,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
    } catch (e) {
      /* 拉起失败就安静退出，至少不会留下一个假死的 node 进程 */
    }
    process.exit(0);
  } else if (alreadyRelaunched) {
    /* 极少见：重拉后仍被污染 → 留证据后退出，避免无声假死 */
    try {
      const { appendFileSync } = require('node:fs') as typeof import('node:fs');
      const { join } = require('node:path') as typeof import('node:path');
      const logDir = process.env.APPDATA ? join(process.env.APPDATA, 'DevAI Studio') : '.';
      appendFileSync(
        join(logDir, 'boot-guard.log'),
        `[${new Date().toISOString()}] 重拉后仍检测到 ELECTRON_RUN_AS_NODE，已放弃启动。\n`
      );
    } catch { }
    process.exit(1);
  }
}
