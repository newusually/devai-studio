/* ============================================================================
 * main/index.ts —— Electron 主进程
 * ----------------------------------------------------------------------------
 * 职责：
 *   1. 创建窗口（隐藏菜单栏、加载渲染进程）
 *   2. 装配 IPC（会话/对话/模型/文件/分析/Git）
 *   3. 全局快捷键（新建会话 / 打开工作区 / 聚焦输入框）
 *   4. 单实例锁 + 开机自启
 * ========================================================================== */
import { app, BrowserWindow, ipcMain, Menu, dialog, shell, globalShortcut, nativeImage } from 'electron';
import { join, dirname, resolve } from 'node:path';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { IPC, ProviderKind, StreamEvent, ChatMessage } from '../shared/types';
import { ProviderRegistry } from './providers';
import { SessionStore } from './store';
import { ToolBox } from './agents/tools';
import { Agent } from './agents/agent';
import { analyzeSource, scoreReport, detectLang } from './analysis/linter';
import { GitService } from './git';
import { MemoryStore } from './memory';
import { ROLES, getRole, pickModelForRole } from './agents/roles';
import { parseVideoScript, generateVideo } from './agents/video';

/* ★开发模式判定（2026-10-25 修复）
 *   原来用 !app.isPackaged，开发时会去连 http://localhost:5173（Vite dev server）。
 *   若 Vite 没启动，渲染进程加载失败 → 页面永远停在"正在启动"。
 *   改为：只有显式设置 DEV_SERVER=<url> 时才走 dev server，
 *   否则一律加载已构建的 dist/renderer/index.html（打包/开发都能跑）。 */
const DEV_SERVER = process.env.DEV_SERVER || '';
const isDevServer = !!DEV_SERVER;

/* ★性能设置（2026-10-25 实测）
 *   本机无独立 GPU（Microsoft 基本显示适配器），Electron 默认会尝试
 *   硬件加速并报 "GetGpuDriverOverlayInfo: Failed to retrieve video device"，
 *   随后回退到 SwiftShader 软件渲染 —— 在无 GPU 机器上反而更耗 CPU。
 *   → 显式禁用硬件加速，让 Chromium 走纯 CPU 路径（对纯文本界面更省）。
 *   → 禁用后台节流，避免空闲时仍在跑合成任务。 */
if (process.env.DEFAI_NO_GPU !== '0') {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
  app.commandLine.appendSwitch('disable-software-rasterizer');
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  app.commandLine.appendSwitch('disable-background-timer-throttling');
  app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
}

/* ---------------- 全局状态 ---------------- */
let mainWindow: BrowserWindow | null = null;
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
/** 当前角色 id */
let currentRole = 'general';

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
  if (!settings.workspace) settings.workspace = join(app.getPath('documents'), 'DevAI-Workspace');
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
    show: false,
    backgroundColor: '#0f1117',
    title: 'DevAI Studio',
    // 无 GPU 机器上降低渲染压力
    paintWhenInitiallyHidden: false,
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

  mainWindow.on('closed', () => { mainWindow = null; });

  /* ★内置自检：electron . --shot  → 自动截图并输出探针数据后退出
   *   用于无头环境下的界面验收（避免外部再起一个 Electron 实例） */
  if (process.argv.includes('--shot')) {
    setTimeout(() => { runSelfCheck(mainWindow!); }, 3500);
  }
  if (process.argv.includes('--e2e')) {
    setTimeout(() => { runE2E(mainWindow!); }, 3000);
  }
}

/* ---------------- 自检 / 截图 ---------------- */
async function runSelfCheck(win: BrowserWindow) {
  const outDir = join(__dirname, '..', '..', 'shots');
  try { if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true }); } catch (e) { }

  const shot = async (name: string) => {
    try {
      const img = await win.webContents.capturePage();
      writeFileSync(join(outDir, name), img.toPNG());
    } catch (e) { }
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

  // 诊断面板
  await probe(`document.querySelector('.modal-x')?.click()`);
  await new Promise(r => setTimeout(r, 500));
  await probe(`Array.from(document.querySelectorAll('.tabs .tab')).find(t=>t.textContent.includes('问题'))?.click()`);
  await new Promise(r => setTimeout(r, 700));
  await shot('05-diag.png');

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

/* ---------------- 查找 Ollama ---------------- */
function findOllama(): string | null {
  const cands = [
    'F:////dev-ai////ollama////ollama.exe',
    join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe'),
    'C:////Program Files\\Ollama\\ollama.exe',
    'ollama.exe',
  ];
  for (const c of cands) {
    try { if (existsSync(c)) return c; } catch (e) { }
  }
  return null;
}

/* ---------------- 推荐模型清单（全部免费开源） ---------------- */
const RECOMMENDED_MODELS = [
  { name: 'qwen3:4b', size: '2.5GB', mem: '4GB', lang: '中文强', use: '8G 机器最稳档 · 通用 + 中文', pull: true },
  { name: 'qwen3:8b', size: '5.2GB', mem: '8GB', lang: '中文强', use: '8G 机器推荐 · 综合能力更强', pull: true },
  { name: 'qwen2.5-coder:7b', size: '4.7GB', mem: '8GB', lang: '中英双语', use: '纯代码任务最佳', pull: true },
  { name: 'qwen2.5-coder:1.5b', size: '1.0GB', mem: '2GB', lang: '中英双语', use: '超轻量 · 代码补全', pull: true },
  { name: 'deepseek-r1:1.5b', size: '1.1GB', mem: '2GB', lang: '中文强', use: '轻量推理链', pull: true },
  { name: 'gemma2:2b', size: '1.6GB', mem: '3GB', lang: '英文强', use: '英文任务 · Google 开源', pull: true },
  { name: 'llama3.2:3b', size: '2.0GB', mem: '4GB', lang: '英文强', use: 'Meta 开源 · 英文优秀', pull: true },
  { name: 'llama3.1:8b', size: '4.9GB', mem: '8GB', lang: '英文强', use: '英文任务主力', pull: true },
  { name: 'phi4:7b', size: '4.2GB', mem: '8GB', lang: '英文强', use: '微软开源 · 推理强', pull: true },
  { name: 'codellama:7b', size: '3.8GB', mem: '6GB', lang: '英文', use: 'Meta 代码模型', pull: true },
  { name: 'mistral-nemo:12b', size: '7.1GB', mem: '12GB', lang: '英文强', use: '需要 12G+ 内存', pull: true },
  { name: 'gemma2:9b', size: '5.4GB', mem: '10GB', lang: '英文强', use: 'Google 开源 · 需 10G+', pull: true },
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
    if (model) registry.setOverride(kind, { model });
    settings.currentProvider = kind;
    saveSettings();
    return registry.describe();
  });

  ipcMain.handle(IPC.MODEL_PROBE, async () => registry.probeAll());

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
      registry, tools, workspace, memory,
      role: getRole(roleId),
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

  /* ---- 模型管理（一键下载本地模型） ---- */
  ipcMain.handle(IPC.MODEL_PULL, async (_e, modelName: string) => {
    // 通过 Ollama API 触发下载（ollama 的 pull 是异步的，用 stream 返回进度）
    const { spawn } = require('node:child_process');
    const ollamaExe = findOllama();
    if (!ollamaExe) return { ok: false, error: '未找到 Ollama 可执行文件' };
    return new Promise((resolve) => {
      const p = spawn(ollamaExe, ['pull', modelName], {
        cwd: workspace, windowsHide: true,
        env: { ...process.env, OLLAMA_MODELS: process.env.OLLAMA_MODELS || 'F:////ollama-models' },
      });
      let out = '';
      p.stdout.on('data', d => { out += d.toString(); });
      p.stderr.on('data', d => { out += d.toString(); });
      p.on('close', (code) => resolve({ ok: code === 0, output: out.slice(-2000) }));
      p.on('error', (e: any) => resolve({ ok: false, error: e?.message || String(e) }));
    });
  });

  ipcMain.handle(IPC.MODEL_RECOMMEND, async () => RECOMMENDED_MODELS);

  /* ---- AI 短视频 ---- */
  ipcMain.handle(IPC.VIDEO_SCRIPT, async (_e, topic: string) => {
    const provider = registry.create();
    if (!provider) return { ok: false, error: '没有可用模型' };
    try {
      const resolved = await registry.resolveModel(provider.kind);
      if (resolved) (provider as any).model = resolved;
    } catch (e) { }
    const sys = `你是短视频内容策划。请为下面的话题产出【JSON 格式】的短视频脚本：
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
    const res = await provider.chat({
      messages: [{ role: 'system', content: sys }, { role: 'user', content: topic }],
      temperature: 0.7, maxTokens: 2000,
    });
    if (res.error) return { ok: false, error: res.error };
    const script = parseVideoScript(res.content);
    if (!script) return { ok: false, error: '未能解析脚本', raw: res.content.slice(0, 500) };
    return { ok: true, script, model: res.model };
  });

  ipcMain.handle(IPC.VIDEO_GENERATE, async (_e, script: any, outName?: string) => {
    const outDir = join(workspace, 'video-output', outName || `video-${Date.now()}`);
    return generateVideo(script, outDir);
  });

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
    const results = [];
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
    const out = [];
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

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
   try {
    /* ★界面语言锁定中文：系统对话框/文件选择器/右键菜单都跟着变中文 */
    app.commandLine.appendSwitch('lang', 'zh-CN');
    process.env.LANG = 'zh_CN.UTF-8';
    process.env.LC_ALL = 'zh_CN.UTF-8';

    dataDir = join(app.getPath('userData'), 'data');
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

    loadSettings();

    store = new SessionStore(dataDir);
    registry = new ProviderRegistry(settings.providers);
    registry.setCurrent(settings.currentProvider as ProviderKind);

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
    settings.workspace = workspace;
    saveSettings();
    agent = new Agent({
      registry, tools, workspace, memory,
      role: getRole(currentRole),
      emit: (e) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send(IPC.CHAT_STREAM, e);
        }
      },
    });

    registerIpc();
    buildMenu();
    createWindow();

    /* 全局快捷键 */
    globalShortcut.register('CommandOrControl+Shift+Space', () => {
      mainWindow?.show();
      mainWindow?.focus();
      mainWindow?.webContents.send('menu:action', 'focus-input');
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
   } catch (e: any) {
    console.error('[main] 启动失败:', e);
    dialog.showErrorBox('DevAI Studio 启动失败',
      `${e?.message || e}\n\n${e?.stack || ''}`);
   }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('will-quit', () => {
    store?.close();
    globalShortcut.unregisterAll();
  });
}


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
