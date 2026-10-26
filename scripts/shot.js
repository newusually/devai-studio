/* DevAI Studio 界面验收脚本（用 Electron 自身截图，不依赖外部 Chrome）
 * 用法: node scripts/shot.js
 */
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');
const fs = require('fs');

// ★关键：复用真实主进程的 IPC 注册逻辑
//   直接 require dist/main/index.js 会启动它自己的窗口，这里改为
//   把主进程里的 IPC handler 抽出来注册 —— 用环境变量让主进程只导出 handler
process.env.DEFAI_HEADLESS = '1';
const mainModule = require(path.join(__dirname, '..', 'dist', 'main', 'index.js'));

const OUT = path.join(__dirname, '..', 'shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const wait = ms => new Promise(r => setTimeout(r, ms));

app.whenReady().then(async () => {
  await wait(1200);   // 等主进程注册完 IPC

  const win = new BrowserWindow({
    width: 1500, height: 940, show: true,
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, '..', 'dist', 'preload', 'index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  const errors = [];
  win.webContents.on('console-message', (e, level, msg) => {
    if (level >= 2) errors.push(msg);
  });

  await win.loadFile(path.join(__dirname, '..', 'dist', 'renderer', 'index.html'));
  await wait(3500);

  // 1. 欢迎页
  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '01-welcome.png'), img.toPNG());
  });

  // 2. 检查关键元素
  const probe = await win.webContents.executeJavaScript(`(() => {
    const q = s => document.querySelectorAll(s).length;
    return {
      title: document.title,
      sidebar: q('.sidebar'),
      brand: (document.querySelector('.brand-name')||{}).textContent,
      roleSelect: q('.role-select'),
      roleOptions: Array.from(document.querySelectorAll('.role-select option')).map(o=>o.textContent),
      welcome: q('.welcome'),
      tips: q('.welcome-tips .tip'),
      composer: q('.composer-box'),
      tabs: Array.from(document.querySelectorAll('.tabs .tab')).map(t=>t.textContent.trim()),
      modelBox: (document.querySelector('.model-id')||{}).textContent,
      quota: (document.querySelector('.model-quota')||{}).textContent,
    };
  })()`);
  console.log('PROBE=' + JSON.stringify(probe, null, 1));

  // 3. 打开模型库面板
  await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.agent-links .link-btn')).find(b=>b.textContent.includes('模型库'))?.click()
  `);
  await wait(900);
  const modelRows = await win.webContents.executeJavaScript(`q => document.querySelectorAll('.model-row').length`);
  console.log('MODEL_ROWS=' + modelRows);
  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '02-models.png'), img.toPNG());
  });

  // 4. 打开学习面板
  await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.agent-links .link-btn')).find(b=>b.textContent.includes('学习'))?.click()
  `);
  await wait(900);
  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '03-memory.png'), img.toPNG());
  });

  // 5. 打开设置弹窗
  await win.webContents.executeJavaScript(`
    document.querySelector('.model-box .link-btn')?.click()
  `);
  await wait(1500);
  const slots = await win.webContents.executeJavaScript(`document.querySelectorAll('.slot').length`);
  console.log('SLOTS=' + slots);
  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '04-settings.png'), img.toPNG());
  });

  // 6. 扫工作区（诊断面板）
  await win.webContents.executeJavaScript(`
    document.querySelector('.modal-x')?.click()
  `);
  await wait(500);
  await win.webContents.executeJavaScript(`
    Array.from(document.querySelectorAll('.tabs .tab')).find(t=>t.textContent.includes('问题'))?.click()
  `);
  await wait(600);
  await win.webContents.capturePage().then(img => {
    fs.writeFileSync(path.join(OUT, '05-diag.png'), img.toPNG());
  });

  console.log('ERRORS=' + JSON.stringify(errors.slice(0, 10)));
  console.log('SHOTS=' + OUT);
  app.quit();
});
