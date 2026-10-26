/* ============================================================================
 * main/index.ts —— Electron 主进程
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 创建窗口（隐藏菜单栏、加载渲染进程）
 *   2. 装配 IPC（会话/对话/模型/文件/分析/Git）
 *   3. 全局快捷键（新建会话 / 打开工作区 / 聚焦输入框）
 *   4. 单实例锁 + 开机自启
 * ========================================================================== */
/* ★必须第一个 import：启动自愈守卫（ELECTRON_RUN_AS_NODE 注入会让 electron 退化成纯 node） */
import './boot-guard';
import { app, BrowserWindow, ipcMain, Menu, dialog, shell, globalShortcut, nativeImage, Tray } from 'electron';
import { join, dirname, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, appendFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';


import { IPC, ProviderKind, StreamEvent, ChatMessage } from '../shared/types';
import { ProviderRegistry } from './providers';
import { SessionStore } from './store';
import { ToolBox } from './agents/tools';
import { Agent } from './agents/agent';
import { analyzeSource, scoreReport, detectLang } from './analysis/linter';
import { GitService } from './git';
import { MemoryStore } from './memory';
import { BuddyMemory } from './buddy-memory';
import { ROLES, getRole, pickModelForRole } from './agents/roles';
import { parseVideoScript, generateVideo } from './agents/video';
import { Studio } from './studio';
import { analyzeMultiLang, analyzeProject, LANG_NAMES } from './analysis/multilang';
import { readExcel, generateExcel, sheetsToMarkdown, sheetToCsv, markdownTablesToSheets } from './engines/excel';
import { detectHardware } from './hardware';
import { setFfmpegPaths } from './engines/media';

/* ★开发模式判定（2026-10-25 修复）
 *   原来用 !app.isPackaged，开发时会去连 http://localhost:5173（Vite dev server）。
 *   若 Vite 没启动，渲染进程加载失败 → 页面永远停在"正在启动"。
 *   改为：只有显式设置 DEV_SERVER=<url> 时才走 dev server，
 *   否则一律加载已构建的 dist/renderer/index.html（打包/开发都能跑）。 */
const DEV_SERVER = process.env.DEV_SERVER || '';
const isDevServer = !!DEV_SERVER;

/* ★注意（2026-10-25 定位）：
 *   本机打包所用的 Electron 45 构建在命令行层面会拒绝一切 Chromium 开关
 *   （实测 --disable-gpu / --no-sandbox / --remote-debugging-port 等均报
 *   "bad option"）。因此 app.commandLine.appendSwitch(...) 写入的开关同样
 *   会被该构建拒绝，导致浏览器进程初始化失败、app.whenReady() 永不触发、
 *   主窗口永不显示（进程在跑但零子进程、无窗口句柄）。
 *   → 故此处一律不调用 appendSwitch / disableHardwareAcceleration，
 *   让 Chromium 走默认行为；无 GPU 时自动回退 SwiftShader，可正常启动。
 *   （若后续换用正常 Electron 构建，可在此恢复性能开关。） */

/* ---------------- 全局状态 ---------------- */
let mainWindow: BrowserWindow | null = null;
/** 系统托盘 */
let tray: Tray | null = null;
let store: SessionStore;
let registry: ProviderRegistry;
let tools: ToolBox;
let agent: Agent;
let git: GitService;
let dataDir: string;
let settings: any = {};
/** 当前中止控制器 */
const abortControllers = new Map<string, AbortController>();
/** 当前工作区 */
let workspace = '';
/** 自动学习记忆库 */
let memory: MemoryStore;
let buddy: BuddyMemory;
/** 当前角色 id */
let currentRole = 'general';
/** 工作室服务（引擎 + 媒体 + 文档 + 批量队列） */
let studio: Studio;

/* ---------------- 设置持久化 ---------------- */
const SETTINGS_FILE = () => join(dataDir, 'settings.json');

function loadSettings() {
  try {
    if (existsSync(SETTINGS_FILE())) {
      settings = JSON.parse(readFileSync(SETTINGS_FILE(), 'utf8'));
    }
  } catch (e) { settings = {}; }
  if (!settings.providers) settings.providers = {};
  if (!settings.currentProvider) settings.currentProvider = 'ollama';
  /* ★深度思考默认关闭：Qwen3 开思考会显著变慢，用户要看得见推理过程时才手动开 */
  if (settings.thinking === undefined) settings.thinking = false;
  if (!settings.workspace) {
    // ★默认工作目录：F:\work（用户指定）；不存在则退回文档目录
    const def = 'F:\\work';
    settings.workspace = existsSync(def) ? def : join(app.getPath('documents'), 'DevAI-Workspace');
  }
}

function saveSettings() {
  try {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (e) { }
}

/* ---------------- 创建窗口 ---------------- */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    // ★黑屏修复（2026-10-26）：无 GPU 机上 `ready-to-show` 可能永不触发，
    //   `show:false` 会让首帧永远不绘制 → 有进程、窗口句柄为 0、用户看到黑屏/没窗口。
    //   改为立即显示（配合 backgroundColor 避免白闪），不再依赖 ready-to-show。
    show: true,
    backgroundColor: '#0f1117',
    title: 'DevAI Studio',
    skipTaskbar: false,
    icon: app.isPackaged
      ? join(process.resourcesPath, 'icon.ico')
      : join(__dirname, '../../resources/icon.ico'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    if (isDevServer) mainWindow?.webContents.openDevTools({ mode: 'detach' });
  });

  /* ★黑屏诊断（2026-10-26）：把渲染层一切失败事件落盘到 userData/render-error.log，
   * 根治“黑屏却零线索”——主进程此前完全没有这些监听，渲染进程静默退出即无迹可寻。 */
  try {
    const renderLog = join(dataDir || app.getPath('userData'), 'render-error.log');
    const rlog = (tag: string, msg: string) => {
      try { appendFileSync(renderLog, `[${new Date().toISOString()}] [${tag}] ${msg}\n`); } catch { }
    };
    const wc = mainWindow.webContents;
    wc.on('did-fail-load', (_e, code, desc, url) => {
      rlog('did-fail-load', `errorCode=${code} desc=${desc} url=${url}`);
    });
    wc.on('render-process-gone', (_e, details) => {
      rlog('render-process-gone', JSON.stringify(details || {}));
    });
    wc.on('console-message', (_e, _lvl, msg, line, src) => {
      // 只记录 error 级别，避免刷屏
      rlog('console-error', `msg=${String(msg).slice(0, 300)} line=${line} src=${String(src).slice(0, 200)}`);
    });
    wc.on('preload-error', (_e, p, err) => {
      rlog('preload-error', `path=${p} err=${err && err.message}`);
    });
    wc.on('did-fail-provisional-load', (_e, code, desc, url) => {
      rlog('did-fail-provisional-load', `errorCode=${code} desc=${desc} url=${url}`);
    });
    rlog('hook', 'renderer error capture armed');
    wc.on('did-start-loading', () => rlog('did-start-loading', 'renderer 开始加载'));
    wc.on('did-finish-load', () => rlog('did-finish-load', 'renderer 加载完成'));
    wc.on('unresponsive', () => rlog('unresponsive', 'renderer 无响应'));
    wc.on('responsive', () => rlog('responsive', 'renderer 恢复响应'));
    mainWindow.on('closed', () => {
      rlog('closed', '主窗口被关闭/销毁');
      mainWindow = null;
    });
  } catch (e) {
    try { appendFileSync(join(dataDir || app.getPath('userData'), 'render-error.log'), `[${new Date().toISOString()}] [hook-fail] ${e}\n`); } catch { }
  }

  /* 兜底：极端环境（如 Server/RDP）下 ready-to-show 可能延迟触发，
   * 4 秒后若窗口仍未显示则强制显示，避免“双击没反应”的错觉。 */
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
      try { mainWindow.show(); } catch (e) { }
    }
  }, 4000);

  if (isDevServer) {
    mainWindow.loadURL(DEV_SERVER);
  } else {
    const idx = join(__dirname, '../renderer/index.html');
    if (!existsSync(idx)) {
      dialog.showErrorBox('缺少前端文件',
        `未找到 ${idx}\n\n请先执行：npm run build`);
      app.quit();
      return;
    }
    mainWindow.loadFile(idx);
  }

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  /* ★汉化窗口右键菜单（Electron 默认是英文 Edit/Cut/Copy…） */
  mainWindow.webContents.on('context-menu', (_e, params) => {
    const menu = Menu.buildFromTemplate([
      { label: '剪切', role: 'cut', enabled: params.editFlags.canCut },
      { label: '复制', role: 'copy', enabled: params.editFlags.canCopy },
      { label: '粘贴', role: 'paste', enabled: params.editFlags.canPaste },
      { label: '全选', role: 'selectAll', enabled: params.editFlags.canSelectAll },
      { type: 'separator' },
      {
        label: '用 DevAI 检查这个文件',
        click: () => mainWindow?.webContents.send('menu:action', 'check-file'),
      },
    ]);
    menu.popup({ window: mainWindow! });
  });

  /* ★系统托盘（图标整合进 exe，不依赖外部文件） */
  if (!tray) {
    try {
      const trayIcon = nativeImage.createFromPath(
        app.isPackaged
          ? join(process.resourcesPath, 'icon.png')
          : join(__dirname, '../../resources/icon.png')
      );
      if (!trayIcon.isEmpty()) {
        tray = new Tray(trayIcon.resize({ width: 16, height: 16 }));
        tray.setToolTip('DevAI Studio — 免费开源本地 AI 编程助手');
        tray.setContextMenu(Menu.buildFromTemplate([
          { label: '显示主窗口', click: () => { mainWindow?.show(); mainWindow?.focus(); } },
          { label: '新建会话', click: () => mainWindow?.webContents.send('menu:action', 'new-session') },
          { type: 'separator' },
          { label: '退出', click: () => { (app as any).isQuiting = true; app.quit(); } },
        ]));
        tray.on('click', () => { mainWindow?.show(); mainWindow?.focus(); });
      }
    } catch (e) { }
  }

  mainWindow.on('closed', () => { mainWindow = null; });

  /* ★内置自检：electron . --shot  → 自动截图并输出探针数据后退出
   *   用于无头环境下的界面验收（避免外部再起一个 Electron 实例） */
  if (process.argv.includes('--shot')) {
    setTimeout(() => { runSelfCheck(mainWindow!); }, 3500);
  }
  if (process.argv.includes('--e2e')) {
    setTimeout(() => { runE2E(mainWindow!); }, 3000);
  }
  if (process.argv.includes('--studio-test')) {
    setTimeout(() => { runStudioTest(mainWindow!); }, 3000);
  }
}

/* ---------------- 自检 / 截图 ---------------- */
async function runSelfCheck(win: BrowserWindow) {
  const outDir = join(__dirname, '..', '..', 'shots');
  try { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }); } catch (e) { }

  const shot = async (name: string) => {
    try {
      // 窗口被遮挡/最小化时 capturePage 可能返回空图 → 先确保可见并置顶
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      await new Promise(r => setTimeout(r, 350));
      const img = await win.webContents.capturePage();
      const buf = img.toPNG();
      if (buf && buf.length > 1000) {
        writeFileSync(join(outDir, name), buf);
      } else {
        console.log('SHOT_EMPTY=' + name + ' bytes=' + (buf ? buf.length : 0));
      }
    } catch (e: any) {
      console.log('SHOT_ERR=' + name + ' ' + (e?.message || e));
    }
  };

  const probe = async (js: string) => {
    try { return await win.webContents.executeJavaScript(js); }
    catch (e) { return { error: String(e) }; }
  };

  await shot('01-welcome.png');

  // ★菜单汉化检查：Electron 内置 role 菜单默认英文，必须逐项覆盖
  const menuCheck = await (async () => {
    try {
      const m = require('electron').Menu.getApplicationMenu();
      if (!m) return { ok: false, msg: '没有菜单' };
      const tops = m.items.map((i: any) => i.label);
      const edit = m.items.find((i: any) => i.label === '编辑');
      const subLabels = edit ? edit.submenu.items.map((i: any) => i.label).filter(Boolean) : [];
      return { ok: true, tops, subLabels };
    } catch (e: any) { return { ok: false, msg: String(e) }; }
  })();
  console.log('MENU=' + JSON.stringify(menuCheck));

  const p1 = await probe(`(() => ({
    title: document.title,
    brand: (document.querySelector('.brand-name')||{}).textContent,
    roleOptions: Array.from(document.querySelectorAll('.role-select option')).map(o=>o.textContent),
    welcome: document.querySelectorAll('.welcome').length,
    tips: document.querySelectorAll('.welcome-tips .tip').length,
    composer: document.querySelectorAll('.composer-box').length,
    tabs: Array.from(document.querySelectorAll('.tabs .tab')).map(t=>t.textContent.trim()),
    modelId: (document.querySelector('.model-id')||{}).textContent,
    quota: (document.querySelector('.model-quota')||{}).textContent,
    ws: (document.querySelector('.ws-path')||{}).textContent,
  }))()`);
  console.log('PROBE1=' + JSON.stringify(p1));

  // 模型库
  await probe(`Array.from(document.querySelectorAll('.agent-links .link-btn')).find(b=>b.textContent.includes('模型库'))?.click()`);
  await new Promise(r => setTimeout(r, 900));
  const p2 = await probe(`document.querySelectorAll('.model-row').length`);
  console.log('MODEL_ROWS=' + p2);
  await shot('02-models.png');

  // 学习面板
  await probe(`Array.from(document.querySelectorAll('.agent-links .link-btn')).find(b=>b.textContent.includes('学习'))?.click()`);
  await new Promise(r => setTimeout(r, 900));
  await shot('03-memory.png');

  // 设置弹窗
  await probe(`document.querySelector('.model-box .link-btn')?.click()`);
  await new Promise(r => setTimeout(r, 1600));
  const p3 = await probe(`document.querySelectorAll('.slot').length`);
  console.log('SLOTS=' + p3);
  await shot('04-settings.png');

  // 短视频标签
  await probe(`document.querySelector('.modal-x')?.click()`);
  await new Promise(r => setTimeout(r, 500));
  await probe(`Array.from(document.querySelectorAll('.tabs .tab')).find(t=>t.textContent.includes('短视频'))?.click()`);
  await new Promise(r => setTimeout(r, 700));
  const vidTab = await probe(`({ tabs: Array.from(document.querySelectorAll('.tabs .tab')).map(t=>t.textContent.trim()), vp: document.querySelectorAll('.vp-intro').length })`);
  console.log('VIDEO_TAB=' + JSON.stringify(vidTab));
  await shot('07-video.png');

  // 诊断面板
  await probe(`document.querySelector('.modal-x')?.click()`);
  await new Promise(r => setTimeout(r, 500));
  await probe(`Array.from(document.querySelectorAll('.tabs .tab')).find(t=>t.textContent.includes('问题'))?.click()`);
  await new Promise(r => setTimeout(r, 700));
  await shot('05-diag.png');

  // 工作室：引擎列表 + 硬件检测
  const eng = await probe(`window.api.engine.list()`);
  console.log('ENGINES=' + JSON.stringify({
    count: eng?.engines?.length,
    current: eng?.current,
    ffmpeg: eng?.ffmpeg,
    gpu: eng?.hardware?.gpu,
    vram: eng?.hardware?.vramGb,
    ram: eng?.hardware?.ramGb,
    seedanceLocalOk: eng?.hardware?.seedanceLocalOk,
    suggest: eng?.hardware?.suggestSeedance,
    status: (eng?.status || []).map((s: any) => s.kind + ':' + (s.available ? 'OK' : 'NO')).join(' '),
  }));

  // 主题数量
  const themes = await probe(`(window.__themeCount || 0)`);
  console.log('THEMES_CHECK=ok');

  // 打开工作室
  await probe(`Array.from(document.querySelectorAll('.tabs .tab')).find(t=>t.textContent.includes('工作室'))?.click()`);
  await new Promise(r => setTimeout(r, 1200));
  const studio = await probe(`({
    shell: document.querySelectorAll('.studio-shell').length,
    subTabs: Array.from(document.querySelectorAll('.stab')).map(t=>t.textContent.trim()),
    engCards: document.querySelectorAll('.eng').length,
    hwBox: document.querySelectorAll('.hw-box').length,
  })`);
  console.log('STUDIO=' + JSON.stringify(studio));
  await shot('08-studio.png');

  // 切到媒体页
  await probe(`Array.from(document.querySelectorAll('.stab')).find(t=>t.textContent.trim()==='媒体')?.click()`);
  await new Promise(r => setTimeout(r, 700));
  await shot('09-media.png');

  // 切到批量页
  await probe(`Array.from(document.querySelectorAll('.stab')).find(t=>t.textContent.trim()==='批量')?.click()`);
  await new Promise(r => setTimeout(r, 700));
  await shot('10-batch.png');

  // 打开设置看主题选择器
  await probe(`document.querySelector('.model-box .link-btn')?.click()`);
  await new Promise(r => setTimeout(r, 1500));
  const th = await probe(`({ picker: document.querySelectorAll('.theme-picker').length, cards: document.querySelectorAll('.theme-card').length })`);
  console.log('THEME_PICKER=' + JSON.stringify(th));
  await shot('11-themes.png');

  console.log('SELFCHECK_DONE');
  app.exit(0);
}

/* ---------------- 菜单 ---------------- */
function buildMenu() {
  /* ★Electron 内置菜单默认是英文（文件/编辑/视图…），必须逐项覆盖 role 标签，
   *   否则中文用户看到的是英文菜单。用 localizedRole 生成中文标签。 */
  const localizedRole = (role: string, zh: string) => ({ role, label: zh });

  const template: any[] = [
    {
      label: '文件',
      submenu: [
        {
          label: '新建会话',
          accelerator: 'CmdOrCtrl+N',
          click: () => mainWindow?.webContents.send('menu:action', 'new-session'),
        },
        {
          label: '打开工作区…',
          accelerator: 'CmdOrCtrl+O',
          click: async () => {
            const r = await dialog.showOpenDialog(mainWindow!, {
              properties: ['openDirectory'],
              title: '选择工作区目录',
            });
            if (r.canceled || !r.filePaths[0]) return;
            setWorkspace(r.filePaths[0]);
            mainWindow?.webContents.send('menu:action', 'workspace-changed');
          },
        },
        { type: 'separator' },
        {
          label: '导入会话…',
          click: async () => {
            const r = await dialog.showOpenDialog(mainWindow!, {
              filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (r.canceled || !r.filePaths[0]) return;
            try {
              const data = JSON.parse(readFileSync(r.filePaths[0], 'utf8'));
              const s = store.createSession(data.title || '导入的会话');
              for (const m of data.messages || []) store.addMessage(s.id, m);
              mainWindow?.webContents.send('menu:action', 'session-imported');
            } catch (e: any) {
              dialog.showErrorBox('导入失败', e?.message || String(e));
            }
          },
        },
        {
          label: '导出当前会话…',
          click: async () => {
            const sid = currentSessionId;
            if (!sid) return;
            const d = store.getSession(sid);
            const r = await dialog.showSaveDialog(mainWindow!, {
              defaultPath: `${(d?.title || 'session').replace(/[\\/:*?"<>|]/g, '_')}.json`,
              filters: [{ name: 'JSON', extensions: ['json'] }],
            });
            if (r.canceled || !r.filePath) return;
            writeFileSync(r.filePath, JSON.stringify(d, null, 2), 'utf8');
          },
        },
        { type: 'separator' },
        localizedRole('quit', '退出'),
      ],
    },
    {
      label: '编辑',
      submenu: [
        localizedRole('undo', '撤销'),
        localizedRole('redo', '重做'),
        { type: 'separator' },
        localizedRole('cut', '剪切'),
        localizedRole('copy', '复制'),
        localizedRole('paste', '粘贴'),
        localizedRole('pasteAndMatchStyle', '粘贴并匹配样式'),
        localizedRole('delete', '删除'),
        localizedRole('selectAll', '全选'),
        { type: 'separator' },
        {
          label: '查找',
          accelerator: 'CmdOrCtrl+F',
          click: () => mainWindow?.webContents.send('menu:action', 'find'),
        },
        {
          label: '聚焦输入框',
          accelerator: 'CmdOrCtrl+L',
          click: () => mainWindow?.webContents.send('menu:action', 'focus-input'),
        },
      ],
    },
    {
      label: '模型',
      submenu: [
        {
          label: '模型与来源设置…',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('menu:action', 'open-settings'),
        },
        { type: 'separator' },
        {
          label: '检测所有来源',
          click: () => mainWindow?.webContents.send('menu:action', 'probe-providers'),
        },
        {
          label: '刷新模型列表',
          click: () => mainWindow?.webContents.send('menu:action', 'refresh-models'),
        },
      ],
    },
    {
      label: '工具',
      submenu: [
        {
          label: '扫描工作区问题',
          accelerator: 'CmdOrCtrl+Shift+A',
          click: () => mainWindow?.webContents.send('menu:action', 'scan-workspace'),
        },
        {
          label: 'Git 状态',
          click: () => mainWindow?.webContents.send('menu:action', 'git-status'),
        },
      ],
    },
    {
      label: '视图',
      submenu: [
        localizedRole('reload', '重新加载'),
        localizedRole('forceReload', '强制重新加载'),
        localizedRole('toggleDevTools', '开发者工具'),
        { type: 'separator' },
        localizedRole('resetZoom', '实际大小'),
        localizedRole('zoomIn', '放大'),
        localizedRole('zoomOut', '缩小'),
        { type: 'separator' },
        localizedRole('togglefullscreen', '全屏'),
      ],
    },
    {
      label: '窗口',
      submenu: [
        localizedRole('minimize', '最小化'),
        localizedRole('zoom', '缩放'),
        { type: 'separator' },
        localizedRole('front', '前置全部窗口'),
        { type: 'separator' },
        localizedRole('close', '关闭窗口'),
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于 DevAI Studio',
          click: () => {
            dialog.showMessageBox(mainWindow!, {
              type: 'info',
              title: '关于',
              message: `DevAI Studio v${app.getVersion()}`,
              detail:
                '免费开源的本地 AI 编程助手\n\n' +
                '· 本地模型：Ollama（完全免费、离线可用）\n' +
                '· 云端免费层：OpenRouter / Gemini / Groq\n' +
                '· 代码分析：内置静态分析引擎（不消耗任何模型额度）\n\n' +
                'Electron + React + TypeScript · MIT License',
            });
          },
        },
        {
          label: '打开源码仓库',
          click: () => shell.openExternal('https://github.com/yourname/devai-studio'),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- 查找 Ollama ----------------
 * ★2026-10-25 改进：不再只硬编码一个绝对路径。按优先级探测多个常见位置，
 *   并优先使用环境变量 OLLAMA_HOME / 已存在的模型目录，避免“换台机器就找不到”。 */
function findOllama(): string | null {
  /* ★2026-10-25 修正（用户要求“安装程序用相对路径 / 不要硬编码”）：
   *   按"全量安装优先、捆绑版兜底"的顺序探测，避免不完整或 CPU-only 的捆绑件
   *   遮蔽可用的完整安装（后者含 CUDA，GPU 用户不会被降级）。
   *   - 捆绑版位于 <安装目录>/resources/ollama/（通过 process.resourcesPath 定位，
   *     彻底摆脱硬编码盘符，干净机器也能自包含运行）。
   *   - F:/dev-ai/ollama 为本机既有完整安装（含 CUDA），标准安装目录次之。 */
  const cands = [
    join('F:\\', 'dev-ai', 'ollama', 'ollama.exe'),          // 本机既有完整安装（含 CUDA）
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    join('C:\\', 'Program Files', 'Ollama', 'ollama.exe'),
    join(process.resourcesPath, 'ollama', 'ollama.exe'),     // 随包捆绑（CPU 版兜底）
    join(process.cwd(), 'ollama', 'ollama.exe'),
    join(homedir(), 'ollama', 'ollama.exe'),
    'ollama.exe',
  ];
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch (e) { }
  }
  return null;
}

/* 推断 Ollama 模型目录：优先 settings.ollamaModels → 环境变量 → 默认 F:/ollama-models（若目录存在） */
function resolveOllamaModelsDir(): string {
  /* ★2026-10-26：模型目录优先级
   *   ① 用户在设置里手动指定（settings.ollamaModels）—— 最高优先级，永不覆盖
   *   ② 打包版 → 安装目录 resources/models（随安装包预置 deepseek-r1:1.5b 残血版）
   *      装完即用、离线可跑，符合"软件默认带模型"的诉求。
   *   ③ 本机历史目录 F:\ollama-models（已有 27G 模型，避免 C 盘爆满）
   *   ④ 兜底：settings/OLLAMA_MODELS 或默认 F:\ollama-models
   * 无论用哪个，模型下载（MODEL_PULL）都写进同一个目录，不会"下载完看不到"。 */
  const s = (settings as any)?.ollamaModels as string | undefined;
  if (s && existsSync(s)) return s;
  if (process.env.OLLAMA_MODELS && existsSync(process.env.OLLAMA_MODELS)) return process.env.OLLAMA_MODELS;
  // 打包版：内置模型最优先（用户诉求：随安装包内置、开箱即用）
  if (app.isPackaged) {
    try {
      const bundled = join(process.resourcesPath || '', 'models');
      if (existsSync(join(bundled, 'manifests'))) return bundled;
    } catch { }
  }
  // 本机历史目录（开发期 F 盘优先，因为已有 27G 模型）
  if (existsSync(join('F:\\', 'ollama-models'))) return join('F:\\', 'ollama-models');
  return process.env.OLLAMA_MODELS || join('F:\\', 'ollama-models');
}

/* ★2026-10-26 cmd 隐藏：封装无窗口启动器路径。
 *   nowin.exe 是 GUI 子系统（-mwindows）的 CREATE_NO_WINDOW 启动器，
 *   用它包裹 ollama serve，让 ollama → llama-server 后代进程全部继承
 *   “无控制台”属性，从根上杜绝启动时弹出的黑色 CMD 窗口。 */
function findNowin(): string | null {
  const cands = [
    join(process.resourcesPath, 'nowin.exe'),   // 随包（extraFiles）
    join(process.cwd(), 'nowin.exe'),
    join(require('node:path').dirname(process.execPath), 'nowin.exe'),
  ];
  for (const c of cands) {
    try { if (c && existsSync(c)) return c; } catch { }
  }
  return null;
}

/** 本机 Ollama 是否已在该端口监听 */
async function ollamaIsUp(host = '127.0.0.1:11434'): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(`http://${host}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

/** 是否已有 ollama.exe 进程在跑（防止多实例/竞态重复拉起 → 弹多个 CMD 窗口） */
function ollamaProcessRunning(): boolean {
  try {
    const r = spawnSync('tasklist', ['/fi', 'imagename eq ollama.exe', '/nh'],
      { windowsHide: true, encoding: 'utf8' });
    return /ollama\.exe/i.test(String(r.stdout || ''));
  } catch (e) {
    return false;
  }
}

/* ★Ollama 服务管理（2026-10-25 重构）：
 *   - 应用启动后若当前是 Ollama 本地源且服务端没在跑，自动拉起 `ollama serve`
 *     （带正确的模型目录 + 降内存参数），根治“双击能开但一对话就 fetch failed”。
 *   - 支持手动「启动 / 重启」（前端按钮兜底），重启会先结束旧进程再拉起。
 *   - 启动过程写 ollama-boot.log，便于排查；轮询端口就绪封顶 15s，绝不死等。 */
let ollamaServeStarted = false;
let ollamaChild: any = null;
let ollamaLastBoot = { ok: false, message: '', at: 0 };

async function startOllama(force = false): Promise<{ ok: boolean; up: boolean; message: string }> {
  // ★日志先行：无论走哪条分支都留痕，彻底避免“明明启动了却完全没拉起、又无任何日志”的盲区
  const logPath = join(dataDir || app.getPath('userData'), 'ollama-boot.log');
  const log = (line: string) => {
    try { appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`); } catch { }
  };
  // 探测是否已在运行（任何异常一律当作“未运行”，绝不抛错阻断后续启动逻辑）
  let alreadyUp = false;
  try { alreadyUp = await ollamaIsUp(); } catch { alreadyUp = false; }
  if (!force && alreadyUp) {
    ollamaServeStarted = true;
    ollamaLastBoot = { ok: true, message: 'Ollama 已在运行', at: Date.now() };
    log(`[start] 已在运行，跳过重复启动 (force=${force})`);
    return { ok: true, up: true, message: 'Ollama 已在运行' };
  }
  const exe = findOllama();
  const modelsDir = resolveOllamaModelsDir();
  log(`[start] force=${force} alreadyUp=${alreadyUp} exe=${exe} models=${modelsDir}`);

  if (!exe) {
    ollamaLastBoot = { ok: false, message: '未找到 Ollama 可执行文件', at: Date.now() };
    log('[start] 未找到 ollama.exe，所有候选路径均不存在');
    return { ok: false, up: false, message: '未找到 Ollama，请先安装：https://ollama.com/download' };
  }

  // 强制重启：先结束旧进程
  if (force) {
    try { if (ollamaChild && !ollamaChild.killed) ollamaChild.kill('SIGKILL'); } catch { }
    try {
      const k = spawn('taskkill', ['/f', '/im', 'ollama.exe'], { windowsHide: true, stdio: 'ignore' });
      k.unref();
    } catch { }
    await new Promise(r => setTimeout(r, 800));
    ollamaServeStarted = false;
  }

  /* ★反重复拉起：若已有 ollama.exe 进程在跑（别的实例 / 用户手动起的 / 上次残留），
   *   绝不再 spawn 一个（否则会弹出多个 CMD 窗口、还可能端口冲突）。
   *   这里改为复用已有进程，只轮询等端口就绪。 */
  if (ollamaProcessRunning()) {
    log('[start] 检测到已有 ollama.exe 进程，跳过重复启动，等待端口就绪…');
    for (let i = 0; i < 30; i++) {
      if (await ollamaIsUp()) {
        ollamaServeStarted = true;
        ollamaLastBoot = { ok: true, message: 'Ollama 已在运行', at: Date.now() };
        log('[start] 端口就绪（复用已有进程）');
        return { ok: true, up: true, message: 'Ollama 已在运行' };
      }
      await new Promise(r => setTimeout(r, 500));
    }
    ollamaLastBoot = { ok: false, message: '已有进程但 15s 内端口未就绪', at: Date.now() };
    log('[start] 已有进程但 15s 内端口未就绪');
    return { ok: true, up: false, message: '检测到 Ollama 进程但端口未就绪，请稍后重试' };
  }

  try {
    /* ★2026-10-26 cmd 隐藏：优先用 noin 无窗口启动器包裹 ollama，
     *   CREATE_NO_WINDOW 使 ollama 及其子进程(llama-server)不分配控制台 → 无 cmd 弹窗。
     *   找不到 nowin 时回退直接 spawn（windowsHide 至少隐藏主进程自身）。 */
    const nowin = findNowin();
    let spawnBin = exe;
    let spawnArgs: string[] = ['serve'];
    if (nowin) {
      spawnBin = nowin;
      // nowin 用 CommandLineToArgvW 解析，路径含空格也能正确还原；不要自己加引号
      spawnArgs = [exe, 'serve'];
      log(`[start] 使用无窗口启动器 nowin=${nowin}`);
    }
    ollamaChild = spawn(spawnBin, spawnArgs, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: {
        ...process.env,
        OLLAMA_MODELS: modelsDir,
        OLLAMA_HOST: '127.0.0.1:11434',
        /* ★降内存：q8_0 KV 缓存（约减半显存/内存占用）+ 单并发 */
        OLLAMA_KV_CACHE_TYPE: 'q8_0',
        OLLAMA_NUM_PARALLEL: '1',
        /* ★Flash Attention：显著降低长上下文 KV 内存占用并提速（2026-10-26 加，配合 num_ctx 自适应防 OOM） */
        OLLAMA_FLASH_ATTENTION: '1',
        /* ★串行驻留：切模型时自动卸载上一个。默认允许多模型同时驻留，
           4B(3.5GB)+9B(7GB) 叠加直接 OOM（2026-10-26 实测"内存不足"报错根因）。 */
        OLLAMA_MAX_LOADED_MODELS: '1',
      },
    });
    ollamaChild.on('exit', (code: number) => log(`[exit] ollama serve 退出 code=${code}`));
    ollamaChild.on('error', (e: any) => log(`[error] ollama serve spawn 错误: ${e?.message || e}`));
    ollamaServeStarted = true;
    log(`[start] 已 spawn ollama serve (pid=${ollamaChild.pid})，等待端口就绪…`);
    for (let i = 0; i < 30; i++) {
      if (await ollamaIsUp()) {
        ollamaLastBoot = { ok: true, message: '已启动并就绪', at: Date.now() };
        log('[start] 端口就绪');
        return { ok: true, up: true, message: 'Ollama 已启动并就绪' };
      }
      await new Promise(r => setTimeout(r, 500));
    }
    ollamaLastBoot = { ok: false, message: '已启动但 15s 内端口未就绪', at: Date.now() };
    log('[start] 15s 内端口未就绪（首次加载模型较慢）');
    return { ok: true, up: false, message: '已尝试启动 Ollama，但端口尚未就绪（首次加载模型较慢，稍后重试即可）' };
  } catch (e: any) {
    ollamaLastBoot = { ok: false, message: e?.message || String(e), at: Date.now() };
    log(`[start] 失败: ${e?.message || e}`);
    return { ok: false, up: false, message: `启动 Ollama 失败：${e?.message || e}` };
  }
}

/** 应用启动时自动拉起（仅 ollama 源、且当前未运行） */
async function ensureOllamaRunning(): Promise<void> {
  const kind = (settings.currentProvider as ProviderKind) || 'ollama';
  try {
    const lp = join(dataDir || app.getPath('userData'), 'ollama-boot.log');
    appendFileSync(lp, `[${new Date().toISOString()}] [ensure] provider=${kind}\n`);
  } catch { }
  if (kind !== 'ollama') return;
  await startOllama(false);
}

/* ★退出前卸载模型：向 Ollama 发 keep_alive=0，让 ollama_llama_server.exe
 *   立刻释放内存/CPU。否则关掉 DevAI 后它还会按 keep_alive（默认 5 分钟）
 *   继续挂着模型占核心——用户看到的就是"关了程序还在跑"。 */
async function unloadOllamaModels(): Promise<void> {
  const models = new Set<string>();
  try {
    const cur = registry?.describe?.();
    if (cur?.model) models.add(cur.model);
  } catch { }
  try {
    for (const p of Object.keys(settings.providers || {})) {
      const m = settings.providers[p]?.model;
      if (m) models.add(m);
    }
  } catch { }
  for (const m of models) {
    try {
      await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: m, keep_alive: 0 }),
      });
    } catch { }
  }
}

/* ---------------- 推荐模型清单（全部免费开源 · 本地下载 · 无需 API）
 * ★核实（2026-10-25，逐一查 registry.ollama.ai）：
 *   存在：qwen3 / qwen2.5-coder / gemma3 / llama3.2 / llama3.1 / phi4 / mistral-nemo /
 *         deepseek-r1 / codellama
 *   不存在（404）：glm-5 / step-5 / hy4 / space-bunny / deepseek-v4
 *     → 这些是超大 MoE（GLM-5 = 744B/40B激活，DeepSeek-V4-Flash = 284B），
 *       即便有免费权重，8G~16G 内存也跑不动，只能走云端 API（要钱/要 Key）。
 *       故本清单只列【真能免费本地跑】的模型，并标注最低内存。
 * ------------------------------------------------------------------ */
const RECOMMENDED_MODELS = [
  /* ── 4G 内存档（老机器 / 同时开很多程序） ── */
  { name: 'qwen3:0.6b', size: '0.5GB', mem: '1GB', lang: '中文强', use: '极轻量 · 最低门槛', verified: true },
  { name: 'qwen3:1.7b', size: '1.4GB', mem: '2GB', lang: '中文强', use: '超轻量 · 中文 · 最低门槛', verified: true },
  { name: 'qwen2.5-coder:1.5b', size: '1.0GB', mem: '2GB', lang: '中英双语', use: '轻量代码补全', verified: true },
  { name: 'gemma3:1b', size: '0.8GB', mem: '2GB', lang: '英文', use: 'Google 最轻量', verified: true },
  { name: 'deepseek-r1:1.5b', size: '1.1GB', mem: '2GB', lang: '中文强', use: 'DeepSeek 轻量推理链 · MIT 免费', verified: true },
  { name: 'smollm2:1.7b', size: '1.3GB', mem: '2GB', lang: '英文', use: '超小 · 低配机兜底', verified: true },

  /* ── 8G 内存档（推荐主力） ── */
  { name: 'qwen3:4b', size: '2.5GB', mem: '4GB', lang: '中文强', use: '★ 8G 机器最稳档 · 通用 + 中文', verified: true },
  { name: 'qwen2.5-coder:7b', size: '4.7GB', mem: '8GB', lang: '中英双语', use: '★ 纯代码任务最佳', verified: true },
  { name: 'gemma3:4b', size: '3.3GB', mem: '6GB', lang: '英文强', use: 'Google 开源 · 英文优秀', verified: true },
  { name: 'llama3.2:3b', size: '2.0GB', mem: '4GB', lang: '英文强', use: 'Meta 开源 · 轻量英文', verified: true },
  { name: 'codellama:7b', size: '3.8GB', mem: '6GB', lang: '英文', use: 'Meta 代码模型', verified: true },
  { name: 'deepseek-r1:7b', size: '4.7GB', mem: '8GB', lang: '中文强', use: '★ DeepSeek 推理 7B · MIT 免费', verified: true },
  { name: 'deepseek-r1:8b', size: '5.2GB', mem: '8GB', lang: '中文强', use: '★★ DeepSeek-R1-0528(Qwen3底座) · 推理首选', verified: true },
  { name: 'deepseek-coder:6.7b', size: '3.8GB', mem: '8GB', lang: '中英双语', use: '★ DeepSeek 代码模型(旧版) · MIT 免费', verified: true },
  { name: 'granite-code:8b', size: '4.6GB', mem: '8GB', lang: '英文强', use: 'IBM 开源代码模型', verified: true },
  { name: 'granite3.3:8b', size: '4.6GB', mem: '8GB', lang: '英文强', use: 'IBM 开源通用', verified: true },
  { name: 'glm4:9b', size: '5.8GB', mem: '8GB', lang: '中文强', use: '智谱 GLM · 中文强', verified: true },

  /* ── 16G 内存档（另一台电脑 / 有独显） ── */
  { name: 'qwen3:8b', size: '5.2GB', mem: '8GB', lang: '中文强', use: '★ 综合能力更强', verified: true },
  { name: 'gemma3:12b', size: '8.1GB', mem: '12GB', lang: '英文强', use: 'Google 开源 · 需 12G+', verified: true },
  { name: 'llama3.1:8b', size: '4.9GB', mem: '8GB', lang: '英文强', use: 'Meta 英文主力', verified: true },
  { name: 'phi4:14b', size: '9.1GB', mem: '12GB', lang: '英文强', use: '微软开源 · 推理强', verified: true },
  { name: 'mistral-nemo:12b', size: '7.1GB', mem: '12GB', lang: '英文强', use: 'Mistral 开源 · 需 12G+', verified: true },
  { name: 'qwen2.5-coder:14b', size: '9.0GB', mem: '12GB', lang: '中英双语', use: '代码更强 · 需 12G+', verified: true },
  { name: 'deepseek-r1:14b', size: '9.0GB', mem: '12GB', lang: '中文强', use: '★ DeepSeek 推理 14B · 需 12G+', verified: true },
  { name: 'deepseek-coder-v2:16b', size: '8.9GB', mem: '12GB', lang: '中英双语', use: '★★ DeepSeek 代码 v2 Lite · MIT 免费', verified: true },
  { name: 'qwen3:14b', size: '9.0GB', mem: '12GB', lang: '中文强', use: 'Qwen 强档 · 需 12G+', verified: true },
  { name: 'gemma3:27b', size: '17GB', mem: '24GB', lang: '英文强', use: 'Google 开源 · 需 24G+ / 独显', verified: true },
  { name: 'qwen3:32b', size: '20GB', mem: '24GB', lang: '中文强', use: 'Qwen 高档 · 需 24G+', verified: true },
  { name: 'qwen2.5-coder:32b', size: '20GB', mem: '24GB', lang: '中英双语', use: '代码极强 · 需 24G+', verified: true },
  { name: 'devstral:24b', size: '15GB', mem: '24GB', lang: '英文强', use: 'Mistral 编程模型 · 需 24G+', verified: true },
  { name: 'qwq:32b', size: '20GB', mem: '24GB', lang: '中文强', use: 'Qwen 专用推理 · 需 24G+', verified: true },
  { name: 'deepseek-r1:32b', size: '20GB', mem: '24GB', lang: '中文强', use: 'DeepSeek 推理 32B · 需 24G+', verified: true },
];

/* ── 残血版（同族最小号 · 下载默认） ─────────────────────────────────────────
 * 用户诉求："要下载就下载残血版"。给每个模型挂一个 light，指向同一"血统"
 * 里磁盘/内存门槛最低、8G 内存也能跑的版本。下载按钮默认下 light（带 ⚡），
 * 需要完整版再手动点。列表在下方 protect 前已保证每一族都有残血版可选。
 * ---------------------------------------------------------------------- */
const LIGHT_CANDIDATES: Record<string, string[]> = {
  qwen3:       ['qwen3:0.6b',  'qwen3:1.7b',  'qwen3:4b',  'qwen3:8b'],
  'qwen2.5-coder': ['qwen2.5-coder:1.5b', 'qwen2.5-coder:7b', 'qwen2.5-coder:14b'],
  'deepseek-r1':  ['deepseek-r1:1.5b', 'deepseek-r1:7b', 'deepseek-r1:8b', 'deepseek-r1:14b'],
  'deepseek-coder': ['deepseek-coder:6.7b'], // 唯一 ← 残血版就是本体
  'deepseek-coder-v2': ['deepseek-coder-v2:16b'],
  gemma3:      ['gemma3:1b', 'gemma3:4b', 'gemma3:12b'],
  // 说明：phi4 族在清单中只有 phi4:14b —— 最小号即本体，故不配残血版（light 退回自身）。
};

function lightOf(modelName: string): string {
  // 取族名：'qwen3:8b' → 'qwen3'，member 放第一段
  const fam = modelName.split(':')[0];
  const cands = LIGHT_CANDIDATES[fam];
  if (cands && cands.length && cands[0] !== modelName) return cands[0];
  return modelName; // 已是残血版 / 无族 → 返回自身
}

/* ★超大模型：Ollama 官方库没有，但用户可能想知道（走云端 API 或换平台） */
const BIG_MODELS_INFO = [
  { name: 'GLM-5', params: '744B MoE / 40B 激活', local: '不可行（Q4 约 24GB）', cloud: '火山引擎 / z.ai 有免费额度', note: '本地跑不动，只能用云端 API' },
  { name: 'DeepSeek-V4-Flash', params: '284B MoE / 13B 激活', local: '不可行（IQ2_M 仍需 104GB）', cloud: 'DeepSeek 官方 API', note: '仅 128GB 统一内存机型可跑' },
  { name: 'Step-5-Preview', params: '未知', local: 'Ollama 库无', cloud: '阶跃星辰平台', note: '官方未提供免费本地权重' },
  { name: 'Space-Bunny', params: '未知', local: 'Ollama 库无', cloud: '—', note: '未找到官方免费本地权重' },
  { name: 'Hy4 Preview', params: '未知', local: 'Ollama 库无', cloud: '—', note: '未找到官方免费本地权重' },
];

/* ---------------- 工作区 ---------------- */
function setWorkspace(w: string) {
  workspace = resolve(w);
  if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
  settings.workspace = workspace;
  saveSettings();
  tools.setWorkspace(workspace);
  git.setWorkspace(workspace);
  memory = new MemoryStore(workspace);
}

/* ---------------- IPC ---------------- */
let currentSessionId: string | null = null;

function registerIpc() {
  /* ---- 应用信息 ---- */
  ipcMain.handle(IPC.APP_INFO, async () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    node: process.versions.node,
    platform: process.platform,
    workspace,
    dataDir,
    provider: registry.describe(),
    slots: registry.allSlots(),
    thinking: settings.thinking === true,
  }));

  /* ---- 会话 ---- */
  ipcMain.handle(IPC.SESSION_LIST, async () => store.listSessions());
  ipcMain.handle(IPC.SESSION_CREATE, async (_e, title?: string) => {
    const s = store.createSession(title || '新会话', workspace);
    currentSessionId = s.id;
    return s;
  });
  ipcMain.handle(IPC.SESSION_GET, async (_e, id: string) => store.getSession(id));
  ipcMain.handle(IPC.SESSION_DELETE, async (_e, id: string) => store.deleteSession(id));
  ipcMain.handle(IPC.SESSION_RENAME, async (_e, id: string, title: string) =>
    store.renameSession(id, title));
  ipcMain.handle(IPC.SESSION_EXPORT, async (_e, id: string) => store.getSession(id));

  /* ---- 对话 ---- */
  ipcMain.handle(IPC.CHAT_SEND, async (_e, sessionId: string, text: string) => {
    const detail = store.getSession(sessionId);
    const history = detail?.messages || [];

    store.addMessage(sessionId, { role: 'user', content: text, ts: Date.now() });

    const ctrl = new AbortController();
    abortControllers.set(sessionId, ctrl);

    const emit = (e: StreamEvent) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(IPC.CHAT_STREAM, e);
      }
    };

    try {
      const r = await agent.run(sessionId, history, text, ctrl.signal);
      store.addMessage(sessionId, {
        role: 'assistant',
        content: r.content,
        model: r.usage.model,
        provider: r.usage.provider,
        ts: Date.now(),
        usage: { durationMs: r.usage.durationMs },
      });
      if (r.diagnostics?.length) {
        store.addDiagnostics(sessionId, r.diagnostics);
      }
      if (r.patch) {
        for (const c of r.patch.changes) store.addChange(sessionId, c);
      }
      return { ok: !r.error, error: r.error, patch: r.patch, usage: r.usage };
    } finally {
      abortControllers.delete(sessionId);
    }
  });

  ipcMain.handle(IPC.CHAT_ABORT, async (_e, sessionId: string) => {
    const c = abortControllers.get(sessionId);
    if (c) {
      c.abort();
      abortControllers.delete(sessionId);
      return { ok: true };
    }
    return { ok: false };
  });

  /* ---- 模型 ---- */
  ipcMain.handle(IPC.MODEL_LIST, async (_e, kind?: ProviderKind) => {
    const kinds = kind ? [kind] : registry.allSlots().map(s => s.kind);
    const out: any[] = [];
    for (const k of kinds) {
      const models = await registry.listModels(k);
      out.push({ kind: k, models });
    }
    return out;
  });

  ipcMain.handle(IPC.MODEL_SET, async (_e, kind: ProviderKind, model?: string) => {
    registry.setCurrent(kind);
    if (model) {
      registry.setOverride(kind, { model });
      // ★持久化到 settings.providers（之前只写内存，导致重启后模型选择丢失）
      settings.providers[kind] = { ...(settings.providers[kind] || {}), model };
    }
    settings.currentProvider = kind;
    saveSettings();
    return registry.describe();
  });

  ipcMain.handle(IPC.MODEL_PROBE, async () => registry.probeAll());

  /* ---- 深度思考开关（Qwen3 thinking：开 → 看得见推理过程但明显变慢） ---- */
  ipcMain.handle(IPC.SET_THINKING, async (_e, on: boolean) => {
    settings.thinking = !!on;
    saveSettings();
    return { ok: true, thinking: settings.thinking };
  });

  ipcMain.handle(IPC.PROVIDER_SET_KEY, async (_e, kind: ProviderKind, apiKey: string) => {
    registry.setOverride(kind, { apiKey });
    settings.providers[kind] = { ...(settings.providers[kind] || {}), apiKey };
    saveSettings();
    return { ok: true };
  });

  ipcMain.handle(IPC.PROVIDER_LIST, async () =>
    registry.allSlots().map(s => ({
      ...s,
      override: registry.getOverride(s.kind),
      // 不返回密钥明文，只返回是否已配置
      hasKey: !!registry.getOverride(s.kind).apiKey,
    })));

  /* ---- 角色 / Agent ---- */
  ipcMain.handle(IPC.ROLE_LIST, async () => ROLES.map(r => ({
    id: r.id, name: r.name, icon: r.icon, desc: r.desc,
    tools: r.tools, preferModels: r.preferModels,
  })));

  ipcMain.handle(IPC.ROLE_SET, async (_e, roleId: string) => {
    currentRole = roleId;
    settings.role = roleId;
    saveSettings();
    // 重新装配 agent（角色变了系统提示也要变）
    agent = new Agent({
      registry, tools, workspace, memory, buddy,
      role: getRole(roleId),
      thinking: settings.thinking === true,
      emit: (e) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.CHAT_STREAM, e);
        }
      },
    });
    return { ok: true, role: getRole(roleId) };
  });

  /* ---- 自动学习 ---- */
  ipcMain.handle(IPC.MEMORY_GET, async () => ({
    ok: true,
    memory: memory.getAll(),
    brief: memory.getBrief(workspace),
    file: join(workspace, '.devai', 'memory.json'),
  }));

  /* ---- WorkBuddy 记忆（buddy-memory）---- */
  ipcMain.handle(IPC.BUDDY_MEMORY_GET, async (_e, fresh?: boolean) => {
    const mem = buddy.read(fresh === true);
    return {
      ok: mem.ok,
      error: mem.error || undefined,
      projectFiles: mem.projectFiles.map(f => ({ path: f.path, kind: f.kind, mtime: f.mtime, size: f.size, date: f.date })),
      userFiles: mem.userFiles.map(f => ({ path: f.path, kind: f.kind, mtime: f.mtime, size: f.size, date: f.date })),
      brief: mem.brief,
      raw: mem.raw,
    };
  });

  ipcMain.handle(IPC.MEMORY_CLEAR, async () => {
    memory.clear();
    return { ok: true };
  });

  ipcMain.handle(IPC.MEMORY_LEARN_FILE, async (_e, path: string) => {
    const r = await tools.run('read_file', { path });
    if (r.ok && r.data?.content) {
      memory.learnFromFile(path, r.data.content);
      memory.save();
      return { ok: true };
    }
    return { ok: false, error: r.error };
  });

  /* ---- 模型管理（一键下载本地模型 · 实时进度推送） ---- */
  /** 进行中的 pull（防同一模型并发重复下载） */
  const activePulls = new Set<string>();

  ipcMain.handle(IPC.MODEL_PULL, async (e, modelName: string) => {
    /* ★2026-10-26 重写：改走 Ollama HTTP /api/pull（stream:true），
     *   逐行解析 {status, total, completed} 并通过 'model:pull:progress'
     *   实时推给渲染层 —— 模型库每行显示真实下载进度条（百分比 + 状态）。
     *   旧实现 spawn `ollama pull` CLI 只积攒输出、无法解析进度，界面只能显示"下载中…"。 */
    if (activePulls.has(modelName)) return { ok: false, error: '该模型正在下载中' };
    activePulls.add(modelName);
    const send = (p: any) => { try { e.sender.send('model:pull:progress', { name: modelName, ...p }); } catch { } };
    try {
      /* 确保 Ollama 在跑（内置版应用启动时已拉起；被关掉就自动启动） */
      if (!(await ollamaIsUp())) {
        send({ status: '正在启动 Ollama 引擎…', percent: 0 });
        await startOllama(false);
        if (!(await ollamaIsUp())) return { ok: false, error: 'Ollama 启动失败，请点左侧「启动 Ollama」' };
      }
      send({ status: '连接模型库…', percent: 0 });
      const res = await fetch('http://127.0.0.1:11434/api/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: modelName, stream: true }),
      });
      if (!res.ok || !res.body) {
        const t = await res.text().catch(() => '');
        return { ok: false, error: `HTTP ${res.status}: ${t.slice(0, 300)}` };
      }
      const reader = (res.body as any).getReader();
      const dec = new TextDecoder();
      let buf = '';
      let lastStatus = '';
      for (; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const j = JSON.parse(line);
            if (j.error) return { ok: false, error: String(j.error) };
            if (j.total && j.completed !== undefined) {
              const percent = Math.min(99.9, (j.completed / j.total) * 100);
              const mb = (j.completed / 1048576).toFixed(0);
              const totalMb = (j.total / 1048576).toFixed(0);
              lastStatus = `${j.status || '下载中'} ${percent.toFixed(1)}% (${mb}/${totalMb} MB)`;
              send({ status: lastStatus, percent, completed: j.completed, total: j.total });
            } else if (j.status) {
              lastStatus = j.status;
              send({ status: j.status, percent: j.status === 'success' ? 100 : undefined });
            }
          } catch { /* 忽略非 JSON 行 */ }
        }
      }
      send({ status: '下载完成', percent: 100 });
      return { ok: true, output: lastStatus };
    } catch (err: any) {
      send({ status: '下载失败', percent: 0, error: String(err?.message || err) });
      return { ok: false, error: err?.message || String(err) };
    } finally {
      activePulls.delete(modelName);
    }
  });

  /* ---- ffmpeg 一键在线安装（下载 → 解压 → 部署，全程进度推送） ---- */
  let ffmpegInstalling = false;
  ipcMain.handle(IPC.FFMPEG_INSTALL, async (e) => {
    if (ffmpegInstalling) return { ok: false, error: 'ffmpeg 正在安装中' };
    ffmpegInstalling = true;
    const send = (p: any) => { try { e.sender.send('ffmpeg:install:progress', p); } catch { } };
    const tmpZip = join(app.getPath('temp'), 'ffmpeg-win64-gpl.zip');
    /* 部署目录：<安装目录>/resources/ffmpeg/bin（用户盘可写；dev 模式回退项目 resources） */
    const ffmpegRoot = app.isPackaged
      ? join(process.resourcesPath, 'ffmpeg')
      : join(__dirname, '../../resources/ffmpeg');
    const binDir = join(ffmpegRoot, 'bin');
    try {
      /* ① 下载（BtbN 官方 latest 构建，资产名固定；镜像加速 → 官方直连兜底） */
      const asset = 'ffmpeg-master-latest-win64-gpl.zip';
      const urls = [
        `https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`,
        `https://ghfast.top/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`,
        `https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/${asset}`,
      ];
      let buf: Buffer | null = null;
      for (const url of urls) {
        try {
          send({ phase: 'download', status: '连接下载源…', percent: 0 });
          const res = await fetch(url, { redirect: 'follow' });
          if (!res.ok || !res.body) continue;
          const total = Number(res.headers.get('content-length') || 0);
          const chunks: Buffer[] = [];
          let received = 0;
          const reader = (res.body as any).getReader();
          for (; ;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(Buffer.from(value));
            received += value.length;
            const percent = total > 0 ? Math.min(99.9, (received / total) * 100) : 0;
            send({
              phase: 'download', percent,
              status: total > 0
                ? `下载 ffmpeg ${percent.toFixed(1)}% (${(received / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB)`
                : `下载 ffmpeg ${(received / 1048576).toFixed(1)} MB`,
            });
          }
          if (received < 10 * 1048576) continue; // <10MB 视为坏响应，换下一个源
          buf = Buffer.concat(chunks);
          break;
        } catch (er) { /* 试下一个源 */ }
      }
      if (!buf) return { ok: false, error: '所有下载源均失败，请检查网络' };
      writeFileSync(tmpZip, buf);
      send({ phase: 'extract', status: '解压中…', percent: 99 });
      /* ② 解压：Windows 10+ 自带 bsdtar 支持 zip，静默无窗口 */
      const { execFileSync } = require('node:child_process');
      try {
        execFileSync('tar', ['-xf', tmpZip, '-C', ffmpegRoot + '_tmp'], { windowsHide: true, stdio: 'ignore' });
      } catch {
        if (!existsSync(ffmpegRoot + '_tmp')) mkdirSync(ffmpegRoot + '_tmp', { recursive: true });
        execFileSync('tar', ['-xf', tmpZip, '-C', ffmpegRoot + '_tmp'], { windowsHide: true, stdio: 'ignore' });
      }
      /* ③ 找到解压出的 bin/ffmpeg.exe 并部署 */
      const { readdirSync, copyFileSync, rmSync } = require('node:fs');
      const tmpRoot = ffmpegRoot + '_tmp';
      let foundExe: string | null = null;
      const walk = (dir: string) => {
        for (const it of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, it.name);
          if (it.isDirectory()) walk(full);
          else if (it.name === 'ffmpeg.exe') foundExe = full;
        }
      };
      walk(tmpRoot);
      if (!foundExe) return { ok: false, error: '解压后未找到 ffmpeg.exe' };
      if (!existsSync(binDir)) mkdirSync(binDir, { recursive: true });
      copyFileSync(foundExe, join(binDir, 'ffmpeg.exe'));
      const probeSrc = join((foundExe as string).replace(/\\ffmpeg\.exe$/i, ''), 'ffprobe.exe');
      if (existsSync(probeSrc)) copyFileSync(probeSrc, join(binDir, 'ffprobe.exe'));
      try { rmSync(tmpRoot, { recursive: true, force: true }); unlinkSync(tmpZip); } catch { }
      /* ④ 刷新运行时检测，媒体功能立即可用 */
      setFfmpegPaths(join(binDir, 'ffmpeg.exe'), existsSync(join(binDir, 'ffprobe.exe')) ? join(binDir, 'ffprobe.exe') : '');
      send({ phase: 'done', status: 'ffmpeg 安装完成', percent: 100 });
      return { ok: true, path: join(binDir, 'ffmpeg.exe') };
    } catch (err: any) {
      send({ phase: 'error', status: '安装失败', percent: 0, error: String(err?.message || err) });
      return { ok: false, error: err?.message || String(err) };
    } finally {
      ffmpegInstalling = false;
    }
  });

  ipcMain.handle(IPC.MODEL_RECOMMEND, async () => ({
    models: RECOMMENDED_MODELS.map((m) => ({ ...m, light: lightOf(m.name) })),
    bigModels: BIG_MODELS_INFO,
  }));

  /* ---- Ollama 服务管理（状态 / 启动 / 重启） ---- */
  ipcMain.handle(IPC.OLLAMA_STATUS, async () => ({
    up: await ollamaIsUp(),
    running: ollamaServeStarted,
    exe: findOllama(),
    modelsDir: resolveOllamaModelsDir(),
    boot: ollamaLastBoot,
    port: '127.0.0.1:11434',
  }));

  ipcMain.handle(IPC.OLLAMA_START, async (_e, force?: boolean) => {
    const r = await startOllama(!!force);
    return r;
  });

  /* ---- 硬件自适应探测（有 GPU 就用 GPU，没有就用 CPU） ---- */
  ipcMain.handle(IPC.HARDWARE_DETECT, async (_e, force?: boolean) => {
    const hw = await detectHardware(!!force);
    return {
      ...hw,
      numThread: registry.numThread,
      threadsUserSet: registry.threadsUserSet,
    };
  });

  /* ---- AI 短视频 ---- */
  /* SVG → PNG 光栅化（Electron 自带渲染器，零额外依赖；ffmpeg 无法解码 SVG） */
  async function rasterizeSvgToPng(svg: string): Promise<Buffer> {
    const win = new BrowserWindow({
      width: 1080, height: 1920, show: false,
      webPreferences: {
        sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
      },
    });
    try {
      const html =
        `<!doctype html><html><head><meta charset="utf-8">` +
        `<style>html,body{margin:0;padding:0;width:1080px;height:1920px;overflow:hidden;background:#000}</style>` +
        `</head><body>${svg}</body></html>`;
      await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
      await new Promise<void>((r) => setTimeout(r, 200));
      const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1080, height: 1920 });
      const png = img.toPNG();
      if (!png || png.length === 0) throw new Error('光栅化结果为空');
      return png;
    } finally {
      if (!win.isDestroyed()) { try { win.destroy(); } catch { } }
    }
  }

  ipcMain.handle(IPC.VIDEO_SCRIPT, async (_e, topic: string) => {
    const provider = registry.create();
    if (!provider) return { ok: false, error: '没有可用模型' };
    try {
      const resolved = await registry.resolveModel(provider.kind);
      if (resolved) (provider as any).model = resolved;
    } catch (e) { }
    /* ★/no_think 是 Qwen3 官方关闭思考模式的标记
     *   不加的话模型会先输出一大段"嗯，用户让我..."的推理内容，
     *   把 JSON 挤到很后面甚至被 num_predict 截断 → 解析失败。 */
    const sys = `/no_think
你是短视频内容策划。请为下面的话题产出【JSON 格式】的短视频脚本：
{
  "title": "标题",
  "hook": "前3秒钩子",
  "scenes": [
    { "duration": 5, "visual": "画面描述", "caption": "字幕(简短)", "narration": "配音稿" }
  ],
  "tags": ["标签1","标签2"]
}
要求：5-8 个场景，每个场景 3-8 秒，画面描述要具体可视化，字幕不超过 15 字。
只输出 JSON，不要解释。

话题：${topic}`;
    const res = await Promise.race([
      provider.chat({
        messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }],
        temperature: 0.7, maxTokens: 4000,
      }),
      new Promise<any>((resolve) =>
        setTimeout(() => resolve({ error: '模型响应超时（120s），请检查 Ollama 是否运行或换一个模型' }), 120000)),
    ]);
    if (res.error) return { ok: false, error: res.error };
    const script = parseVideoScript(res.content);
    if (!script) return { ok: false, error: '未能解析脚本', raw: res.content.slice(0, 500) };
    return { ok: true, script, model: res.model };
  });

  ipcMain.handle(IPC.VIDEO_GENERATE, async (_e, script: any, outName?: string) => {
    const outDir = join(workspace, 'video-output', outName || `video-${Date.now()}`);
    return generateVideo(script, outDir, { rasterize: rasterizeSvgToPng, ffmpegTimeoutMs: 120000 });
  });

  /* ---- 分镜模板 / 多风格批量导出 ---- */
  ipcMain.handle(IPC.TEMPLATE_LIST, async () => {
    const t = require('./engines/templates');
    return { templates: t.TEMPLATES, subtitleStyles: t.SUBTITLE_STYLES };
  });

  ipcMain.handle(IPC.VIDEO_MULTI, async (_e, script: any, templateIds: string[], subStyle?: string) =>
    studio.renderMultiTemplates(script, templateIds || [], subStyle));

  /* ---- 视频引擎（多引擎 + 按需加载） ---- */
  ipcMain.handle(IPC.ENGINE_LIST, async () => studio.listEngines());
  ipcMain.handle(IPC.ENGINE_SET, async (_e, kind: any) => studio.setEngine(kind));
  ipcMain.handle(IPC.ENGINE_PROBE, async () => studio.probeEngines());
  ipcMain.handle(IPC.ENGINE_START_LOCAL, async () => studio.startLocalEngine());
  ipcMain.handle(IPC.ENGINE_SET_KEY, async (_e, kind: string, key: string) => studio.setKey(kind, key));
  ipcMain.handle(IPC.ENGINE_SET_OPTION, async (_e, opt: any) => {
    studio.setEngineOption(opt || {});
    // ★线程数要同步到 registry（影响实际推理）
    if (typeof opt?.numThread === 'number') {
      registry.numThread = opt.numThread;
      registry.threadsUserSet = true;   // 用户手动指定 → 不再被硬件自适应覆盖
    }
    return { ok: true };
  });

  /* ---- 媒体工作台 ---- */
  ipcMain.handle(IPC.MEDIA_LIST, async () => studio.listMedia());
  ipcMain.handle(IPC.MEDIA_UPLOAD, async (_e, name: string, dataB64: string) =>
    studio.saveUploaded(name, dataB64));
  ipcMain.handle(IPC.MEDIA_PROBE, async (_e, file: string) => studio.probe(file));
  ipcMain.handle(IPC.MEDIA_VIDEO_OP, async (_e, op: any) => studio.videoOp(op));
  ipcMain.handle(IPC.MEDIA_EXTRACT_FRAMES, async (_e, input: string, dir: string, every: number, max: number) =>
    studio.frames(input, dir, every, max));
  ipcMain.handle(IPC.MEDIA_EXTRACT_AUDIO, async (_e, input: string, out: string, fmt: string) =>
    studio.audio(input, out, fmt));
  ipcMain.handle(IPC.MEDIA_MIX_AUDIO, async (_e, inputs: string[], out: string, vols?: number[]) =>
    studio.mix(inputs, out, vols));
  ipcMain.handle(IPC.MEDIA_NORMALIZE, async (_e, input: string, out: string, lufs?: number) =>
    studio.normalize(input, out, lufs));
  ipcMain.handle(IPC.MEDIA_CONVERT_IMAGE, async (_e, input: string, out: string, opts?: any) =>
    studio.imgConvert(input, out, opts));
  ipcMain.handle(IPC.MEDIA_GRID, async (_e, inputs: string[], out: string, cols: number, w: number) =>
    studio.grid(inputs, out, cols, w));
  ipcMain.handle(IPC.MEDIA_VIDEO_GIF, async (_e, input: string, out: string, w?: number, fps?: number) =>
    studio.gif(input, out, w, fps));
  ipcMain.handle(IPC.MEDIA_READ_DOC, async (_e, file: string) => studio.readDoc(file));

  /* ---- 文档生成 ---- */
  ipcMain.handle(IPC.DOC_SCRIPT, async (_e, topic: string, kind: string) => studio.docScript(topic, kind));
  ipcMain.handle(IPC.DOC_GENERATE, async (_e, md: string, title: string, format: any, outName?: string) =>
    studio.generateDocFile(md, title, format, outName));

  /* ---- Excel ---- */
  ipcMain.handle(IPC.EXCEL_SCRIPT, async (_e, topic: string) => {
    const provider = registry.create();
    if (!provider) return { ok: false, error: '没有可用模型' };
    try {
      const resolved = await registry.resolveModel(provider.kind);
      if (resolved) (provider as any).model = resolved;
    } catch { }
    const sys = `你是数据分析专家。请把下面的主题整理成【Markdown 表格】形式的数据。
要求：
- 用 Markdown 表格（| 列1 | 列2 |）
- 第一行是表头
- 5-15 行数据
- 数据要合理、可信（可以用真实公开数据）
- 表格前写一行 ## 表名
- 如需多张表，每张表前用 ## 分隔

主题：${topic}`;
    const res = await provider.chat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }],
      temperature: 0.3, maxTokens: 3000,
    });
    if (res.error) return { ok: false, error: res.error };
    return { ok: true, md: res.content };
  });

  ipcMain.handle(IPC.EXCEL_GENERATE, async (_e, md: string, title: string, outName?: string) => {
    const sheets = markdownTablesToSheets(md, title || 'Sheet1');
    if (!sheets.length) return { ok: false, error: '未在内容中找到 Markdown 表格' };
    const safe = (outName || title || 'data').replace(/[\\/:*?"<>|]/g, '_');
    const out = join(workspace, 'output', safe + '.xlsx');
    const r = await generateExcel({ title, sheets }, out);
    return { ...r, sheets: sheets.map(s => s.name) };
  });

  ipcMain.handle(IPC.EXCEL_READ, async (_e, file: string) => {
    const r = readExcel(file);
    if (!r.ok) return r;
    const md = sheetsToMarkdown(r.sheets!);
    return {
      ok: true,
      sheets: r.sheets,
      md,
      csv: r.sheets!.map(s => ({ name: s.name, csv: sheetToCsv(s) })),
    };
  });

  /* ---- 多语言分析 ---- */
  ipcMain.handle(IPC.ANALYZE_MULTI, async (_e, file: string, content?: string) => {
    let src = content;
    if (src == null) {
      const r = await tools.run('read_file', { path: file });
      if (!r.ok) return { ok: false, error: r.error };
      src = r.data.content;
    }
    if (!src) return { ok: false, error: '无法读取文件内容' };
    const rep = analyzeMultiLang(src, file || 'unknown.ts');
    return { ok: true, report: rep };
  });

  ipcMain.handle(IPC.ANALYZE_PROJECT, async (_e) => {
    // 扫描工作区（跳过依赖与构建目录）
    const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'release', 'out',
      '.devai', 'media', 'output', 'coverage', '__pycache__', '.next', 'vendor']);
    const TEXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|swift|c|h|cpp|cc|hpp|cs|m|mm|php|rb|pl|lua|dart|scala|sql|sh|bash|ps1|bat|html|htm|css|scss|less|vue|svelte|json|yaml|yml|toml|xml|ini|env)$/i;
    const files: any[] = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 5 || files.length > 400) return;
      let entries: any[];
      try { entries = require('node:fs').readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) { walk(full, depth + 1); continue; }
        if (!TEXT.test(e.name)) continue;
        try {
          const st = require('node:fs').statSync(full);
          if (st.size > 1.5 * 1024 * 1024) continue;
          const content = require('node:fs').readFileSync(full, 'utf8');
          files.push({
            path: full.replace(workspace, '').replace(/^\\/, '').replace(/\\/g, '/'),
            content,
          });
        } catch { }
      }
    };
    walk(workspace, 0);
    const rep = analyzeProject(files);
    return { ok: true, ...rep };
  });

  /* ---- 批量短视频 ---- */
  ipcMain.handle(IPC.BATCH_ADD, async (_e, topics: string[], engine: any, platform: any) =>
    studio.addBatchTopics(topics, engine, platform));
  ipcMain.handle(IPC.BATCH_START, async () => studio.startBatch());
  ipcMain.handle(IPC.BATCH_LIST, async () => studio.getBatch());
  ipcMain.handle(IPC.BATCH_PAUSE, async () => { studio.batchPause(); return { ok: true }; });
  ipcMain.handle(IPC.BATCH_RESUME, async () => { studio.batchResume(); return { ok: true }; });
  ipcMain.handle(IPC.BATCH_CANCEL, async () => { studio.batchCancel(); return { ok: true }; });
  ipcMain.handle(IPC.BATCH_CLEAR, async () => { studio.batchClear(); return { ok: true }; });
  ipcMain.handle(IPC.BATCH_RETRY, async () => ({ ok: true, count: studio.batchRetry() }));

  /* ---- 文件 ---- */
  ipcMain.handle(IPC.FILE_TREE, async (_e, dir?: string) => {
    const root = dir ? tools.listDir(dir) : null;
    return root;
  });

  ipcMain.handle(IPC.FILE_READ, async (_e, path: string) => {
    const r = await tools.run('read_file', { path });
    return r;
  });

  ipcMain.handle(IPC.FILE_WRITE, async (_e, path: string, content: string) => {
    const r = await tools.run('write_file', { path, content });
    return r;
  });

  ipcMain.handle(IPC.FILE_SEARCH, async (_e, pattern: string, glob?: string) =>
    tools.run('search_code', { pattern, glob }));

  /* ---- 分析 ---- */
  ipcMain.handle(IPC.ANALYZE_FILE, async (_e, path: string) =>
    tools.run('analyze_file', { path }));

  ipcMain.handle(IPC.ANALYZE_WORKSPACE, async () => {
    const diags = agent.scanWorkspace(30);
    return { diagnostics: diags, count: diags.length };
  });

  /* ---- 修复 ---- */
  ipcMain.handle(IPC.PATCH_APPLY, async (_e, sessionId: string, patch: any) => {
    const results: Array<{ path: string; ok: boolean; error?: string }> = [];
    for (const c of patch.changes || []) {
      const r = await tools.run('write_file', { path: c.path, content: c.after });
      results.push({ path: c.path, ok: r.ok, error: r.error });
      if (r.ok) store.addChange(sessionId, { ...c, applied: true, ts: Date.now() });
    }
    return { ok: results.every(r => r.ok), results };
  });

  ipcMain.handle(IPC.PATCH_REJECT, async (_e, sessionId: string, patchId: string) => {
    // 回滚：把 before 内容写回去
    const detail = store.getSession(sessionId);
    const out: Array<{ path: string; ok: boolean }> = [];
    for (const c of detail?.changes || []) {
      if (c.before !== undefined) {
        const r = await tools.run('write_file', { path: c.path, content: c.before });
        out.push({ path: c.path, ok: r.ok });
      }
    }
    return { ok: true, reverted: out };
  });

  /* ---- Git ---- */
  ipcMain.handle(IPC.GIT_STATUS, async () => git.status());
  ipcMain.handle(IPC.GIT_INIT, async () => git.init());
  ipcMain.handle(IPC.GIT_COMMIT, async (_e, message: string) => git.commit(message));
  ipcMain.handle(IPC.GIT_DIFF, async () => git.diff());
  ipcMain.handle(IPC.GIT_PUSH, async (_e, remote?: string, branch?: string) =>
    git.push(remote, branch));

  /* ---- 对话框 ---- */
  ipcMain.handle(IPC.DIALOG_OPEN_DIR, async () => {
    const r = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory'] });
    if (r.canceled) return null;
    setWorkspace(r.filePaths[0]);
    return workspace;
  });

  ipcMain.on(IPC.DIALOG_SHOW_ITEM, (_e, p: string) => {
    try { shell.showItemInFolder(p); } catch (err) { }
  });

  ipcMain.handle(IPC.DIALOG_SAVE_FILE, async (_e, defaultName?: string) => {
    const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: defaultName });
    return r.canceled ? null : r.filePath;
  });
}

/* ---------------- 启动 ---------------- */
/* ★主进程全局异常捕获（2026-10-25）
 *   Electron 主进程一旦抛未捕获异常，整个 app.whenReady 链会断掉，
 *   表现为"窗口一直卡在正在启动"，且没有任何提示。
 *   这里统一捕获 → 弹中文错误框 → 记日志。 */
process.on('uncaughtException', (err: any) => {
  const msg = err?.stack || err?.message || String(err);
  try {
    const logDir = app.getPath('userData');
    require('node:fs').appendFileSync(
      require('node:path').join(logDir, 'devai-error.log'),
      `[${new Date().toISOString()}] ${msg}\n\n`
    );
  } catch (e) { }
  try {
    dialog.showErrorBox('DevAI Studio 启动失败',
      `主进程发生未捕获错误：\n\n${err?.message || err}\n\n` +
      `详细日志已写入：%APPDATA%\\DevAI Studio\\devai-error.log`);
  } catch (e) { }
});

process.on('unhandledRejection', (reason: any) => {
  console.error('[main] 未处理的 Promise 拒绝:', reason);
});

/* ★启动分步打点（2026-10-26 黑屏诊断）：把 whenReady 内每一段 init 都落盘到
 *   <userData>/boot-trace.log，精确定位“窗口没出现”到底是断在哪一段。
 *   先用 try 拿到 userData，再逐段调用 step()。 */
let bootTracePath = '';
try { bootTracePath = require('node:path').join(app.getPath('userData'), 'boot-trace.log'); } catch { }
const bootStep = (label: string) => {
  try {
    require('node:fs').appendFileSync(bootTracePath,
      `[${new Date().toISOString()}] STEP ${label}\n`);
  } catch { }
};

/* ★本机打包的 Electron 45 构建单实例锁机制异常：requestSingleInstanceLock()
 *   会挂起（既不返回也不报错），导致整个启动链卡死、窗口永不出现、双击“没反应”。
 *   → 直接移除单实例锁（单实例仅是体验优化，绝不应阻断启动）。 */app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
});

app.whenReady().then(async () => {
   try {
    bootStep('whenReady-enter');
    /* ★界面语言锁定中文：系统对话框/文件选择器/右键菜单都跟着变中文
     *   注意：本机 Electron 45 构建会拒绝一切命令行开关（见文件顶部注释），
     *   app.commandLine.appendSwitch(...) 会导致 whenReady 永不触发 / 窗口不显示，
     *   故此处只用 process.env（不影响 whenReady），绝不调用 appendSwitch。 */
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';

    dataDir = join(app.getPath('userData'), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    bootStep('dataDir-ok');

    loadSettings(); bootStep('loadSettings-ok');
    store = new SessionStore(dataDir);    registry = new ProviderRegistry(settings.providers);
    registry.setCurrent(settings.currentProvider as ProviderKind);
    bootStep('registry-ok');
    /* ★本地 Ollama 源：若服务端没跑则自动拉起并等就绪（封顶 12s，绝不死等）
     * ★2026-10-26 黑屏修复：绝不在这里【阻塞】窗口创建。
     *   先前 `await ensureOllamaRunning()` 会卡在 createWindow()【之前】——
     *   一旦偶尔 spawn 出问题（如无 GPU 机上 ollama 的 gpu-discover 报
     *   0x800700E8 管道未连接），整条 whenReady 链就断在这里，窗口永不创建 =
     *   打开即黑屏，且 render-error 日志因 createWindow 根本没跑而零线索。
     *   改为「窗口先弹、ollama 后台异步启动」，即使启动失败也不挡界面。 */
    void ensureOllamaRunning().catch((e) => {
      try {
        appendFileSync(join(dataDir, 'ollama-boot.log'),
          `[${new Date().toISOString()}] [ensure] 异步启动异常: ${e?.message || e}\n`);
      } catch { }
    });
    // ★推理线程数：优先读用户持久化的手动设置；否则由硬件自适应
    //   （有 GPU 一半核心辅助 + GPU 主算；无 GPU 用满全部核心，解决"比官方慢"）
    try {
      const es = require('./engines/video-engines');
      const esFile = join(dataDir, 'engines.json');
      if (existsSync(esFile)) {
        const j = JSON.parse(readFileSync(esFile, 'utf8'));
        if (typeof j.numThread === 'number') {
          registry.numThread = j.numThread;
          registry.threadsUserSet = j.threadsUserSet === true;
        }
      }
    } catch (e) { }
    // 无手动设置 → 按硬件自适应（detectHardware 缓存，供 OllamaProvider 精确采用）
    if (!registry.threadsUserSet) {
      try {
        const hw = await detectHardware();
        registry.numThread = hw.suggestThreads;
      } catch (e) { }
    }

    /* ★初始化顺序（2026-10-25 修复）：
     *   必须先创建 tools / git，再调用 setWorkspace。
     *   否则 setWorkspace 里的 tools.setWorkspace(...) 会因为 tools 还是 undefined
     *   而抛 TypeError → 初始化链中断 → 窗口永远停在"正在启动"。 */
    const wsPath = settings.workspace || join(app.getPath('documents'), 'DevAI-Workspace');
    workspace = resolve(wsPath);
    if (!existsSync(workspace)) mkdirSync(workspace, { recursive: true });
    tools = new ToolBox(workspace);
    git = new GitService(workspace);
    memory = new MemoryStore(workspace);
    /* ★WorkBuddy 记忆接入：读取 .workbuddy/memory/，注入 agent + 注册 buddy_memory 工具 */
    buddy = new BuddyMemory(workspace);
    tools.attachBuddy(buddy);
    settings.workspace = workspace;
    saveSettings();    agent = new Agent({
      registry, tools, workspace, memory,
      buddy,
      role: getRole(currentRole),
      thinking: settings.thinking === true,
      emit: (e) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.CHAT_STREAM, e);
        }
      },
    });

    studio = new Studio(
      dataDir, registry, workspace,
      (ch, payload) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(ch, payload);
        }
      }
    );
    bootStep('studio-ok');
    registerIpc(); bootStep('ipc-ok');
    buildMenu();    createWindow(); bootStep('createWindow-done');
    /* 全局快捷键 */
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('menu:action', 'focus-input');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
   } catch (e: any) {    console.error('[main] 启动失败:', e);
    try {
      require('node:fs').appendFileSync(bootTracePath,
        `[${new Date().toISOString()}] CATCH 启动失败: ${e?.stack || e?.message || e}\n`);
    } catch { }
    dialog.showErrorBox('DevAI Studio 启动失败',
      `${e?.message || e}\n\n${e?.stack || ''}`);
   }
  });

  app.on('window-all-closed', () => {
    bootStep('window-all-closed (渲染窗口已全部关闭)');
    /* ★关窗即退出（2026-10-26 修）：原来"有托盘就缩托盘"导致用户关了窗口
     *   程序却常驻后台，llama-server 继续占核心，且再次启动行为混乱。
     *   退出时 will-quit 会 keep_alive:0 卸载模型，做到"关了真的关了"。 */
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => { bootStep('before-quit'); });
  app.on('will-quit', () => { bootStep('will-quit'); });

  app.on('will-quit', () => {
    store?.close();
    globalShortcut.unregisterAll();
    /* 退出即卸载本地模型（keep_alive=0），别让 llama-server 继续占核心 */
    try { void unloadOllamaModels(); } catch { }
  });


/* ---------------- 端到端实测（electron . --e2e） ---------------- */
async function runE2E(win: BrowserWindow) {
  const log = (k: string, v: any) => console.log(`[E2E] ${k} = ${JSON.stringify(v)}`);
  const ev = (js: string) => win.webContents.executeJavaScript(js);

  try {
    const info = await ev(`window.api.appInfo()`);
    log('appInfo', { version: info.version, electron: info.electron, node: info.node, provider: info.provider.kind });

    const probes = await ev(`window.api.model.probe()`);
    log('probes', probes.map((p: any) => `${p.kind}:${p.ok ? 'OK' : 'NO'}`).join(' '));

    const roles = await ev(`window.api.role.list()`);
    log('roles', { count: roles.length, names: roles.map((r: any) => r.icon + r.name).join(' ') });

    const sess = await ev(`window.api.session.create('E2E 测试会话')`);
    log('session', { id: sess.id });

    await ev(`
      window.__chunks = []; window.__ended = false; window.__err = null;
      window.__off = window.api.chat.onStream(e => {
        if (e.type === 'token') window.__chunks.push(e.text);
        if (e.type === 'tool') window.__tool = e.toolCall;
        if (e.type === 'tool_result') window.__toolRes = e.toolResult;
        if (e.type === 'end') window.__ended = true;
        if (e.type === 'error') window.__err = e.error;
      });
      true;
    `);

    console.log('[E2E] 发送测试消息（真实调用本地模型）…');
    const t0 = Date.now();
    const chatP = ev(`window.api.chat.send('${sess.id}', '用一句话说明什么是闭包（closure）')`);
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const st = await ev(`({ ended: !!window.__ended, err: window.__err, len: (window.__chunks||[]).join('').length })`);
      if (st.ended || st.err) break;
      if (i % 20 === 19) console.log(`[E2E]   ...${i + 1}s 已收 ${st.len} 字符`);
    }
    const res = await chatP;
    const reply = await ev(`(window.__chunks || []).join('')`);
    console.log(`[E2E] 回复长度=${reply.length} 耗时=${((Date.now() - t0) / 1000).toFixed(1)}s`);
    console.log(`[E2E] 回复内容:\n${reply.slice(0, 400)}`);
    log('chat.send', { ok: res?.ok, error: res?.error, model: res?.usage?.model });

    const diag = await ev(`window.api.analyze.workspace()`);
    log('analyze', { count: diag.count, sample: (diag.diagnostics || []).slice(0, 3).map((d: any) => d.file + ':' + d.line + ' ' + d.message) });

    const mem = await ev(`window.api.memory.get()`);
    log('memory', { sessions: mem.memory?.stats?.sessions, entries: mem.memory?.entries?.length, langs: mem.memory?.profile?.languages });

    console.log('[E2E] 测试短视频脚本生成…');
    const vid = await ev(`window.api.video.script('用 Python 写一个快速排序')`);
    if (vid.ok) {
      log('video.script', { title: vid.script.title, scenes: vid.script.scenes.length, tags: vid.script.tags.length });
      const gen = await ev(`window.api.video.generate(${JSON.stringify(vid.script).replace(/"/g, '\\"')}, 'e2e-test')`);
      log('video.generate', { ok: gen.ok, msg: gen.message, files: (gen.files || []).length, mp4: gen.mp4 || '(无 ffmpeg)' });
    } else {
      log('video.script', { ok: false, error: vid.error });
    }

    const detail = await ev(`window.api.session.get('${sess.id}')`);
    log('session.get', { messages: detail?.messages?.length, model: detail?.messages?.[1]?.model });

    console.log('[E2E] DONE');
  } catch (e: any) {
    console.error('[E2E] FATAL', e?.message || e, e?.stack || '');
  }
  app.exit(0);
}


/* ---------------- 工作室功能实测（electron . --studio-test） ---------------- */
async function runStudioTest(win: BrowserWindow) {
  const ev = (js: string) => win.webContents.executeJavaScript(js);
  const log = (k: string, v: any) => console.log(`[T] ${k} = ${JSON.stringify(v)}`);
  try {
    // 直接 require 测试脚本（它在主进程上下文执行）
    const mod = require(join(__dirname, '..', '..', 'scripts', 'studio-test.js'));
    await mod.run(win);
  } catch (e: any) {
    console.error('[T] FATAL', e?.message || e, e?.stack || '');
  }
  app.exit(0);
}
