/* ============================================================================
 * preload/index.ts —— 安全桥接
 * ----------------------------------------------------------------------------
 * 渲染进程通过 contextBridge 暴露 window.api，
 * 所有敏感操作（密钥、命令执行、文件写入）都在主进程完成，
 * 渲染进程拿不到 API Key 明文，也拿不到 Node 能力。
 * ========================================================================== */
import { contextBridge, ipcRenderer } from 'electron';
import { IPC, StreamEvent } from '../shared/types';

const api = {
  /* 应用信息 */
  appInfo: () => ipcRenderer.invoke(IPC.APP_INFO),

  /* 会话 */
  session: {
    list: () => ipcRenderer.invoke(IPC.SESSION_LIST),
    create: (title?: string) => ipcRenderer.invoke(IPC.SESSION_CREATE, title),
    get: (id: string) => ipcRenderer.invoke(IPC.SESSION_GET, id),
    remove: (id: string) => ipcRenderer.invoke(IPC.SESSION_DELETE, id),
    rename: (id: string, title: string) => ipcRenderer.invoke(IPC.SESSION_RENAME, id, title),
    export: (id: string) => ipcRenderer.invoke(IPC.SESSION_EXPORT, id),
  },

  /* 对话 */
  chat: {
    send: (sessionId: string, text: string) => ipcRenderer.invoke(IPC.CHAT_SEND, sessionId, text),
    abort: (sessionId: string) => ipcRenderer.invoke(IPC.CHAT_ABORT, sessionId),
    /** 订阅流式事件 */
    onStream: (cb: (e: StreamEvent) => void) => {
      const handler = (_e: any, data: StreamEvent) => cb(data);
      ipcRenderer.on(IPC.CHAT_STREAM, handler);
      return () => ipcRenderer.removeListener(IPC.CHAT_STREAM, handler);
    },
  },

  /* 角色 / Agent */
  role: {
    list: () => ipcRenderer.invoke(IPC.ROLE_LIST),
    set: (id: string) => ipcRenderer.invoke(IPC.ROLE_SET, id),
  },

  /* 自动学习 */
  memory: {
    get: () => ipcRenderer.invoke(IPC.MEMORY_GET),
    clear: () => ipcRenderer.invoke(IPC.MEMORY_CLEAR),
    learnFile: (path: string) => ipcRenderer.invoke(IPC.MEMORY_LEARN_FILE, path),
  },

  /* WorkBuddy 记忆（.workbuddy/memory/） */
  buddyMemory: {
    get: (fresh?: boolean) => ipcRenderer.invoke(IPC.BUDDY_MEMORY_GET, fresh),
  },

  /* 模型 */
  model: {
    pull: (name: string) => ipcRenderer.invoke(IPC.MODEL_PULL, name),
    /** ★订阅模型下载实时进度（模型库每行进度条） */
    onPullProgress: (cb: (p: any) => void) => {
      const handler = (_e: any, p: any) => cb(p);
      ipcRenderer.on('model:pull:progress', handler);
      return () => ipcRenderer.removeListener('model:pull:progress', handler);
    },
    recommend: () => ipcRenderer.invoke(IPC.MODEL_RECOMMEND),
    list: (kind?: string) => ipcRenderer.invoke(IPC.MODEL_LIST, kind),
    set: (kind: string, model?: string) => ipcRenderer.invoke(IPC.MODEL_SET, kind, model),
    probe: () => ipcRenderer.invoke(IPC.MODEL_PROBE),
    slots: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),
    setKey: (kind: string, key: string) => ipcRenderer.invoke(IPC.PROVIDER_SET_KEY, kind, key),
    setThinking: (on: boolean) => ipcRenderer.invoke(IPC.SET_THINKING, on),
  },

  /* ffmpeg 一键在线安装（下载/解压/部署，全程进度） */
  ffmpeg: {
    install: () => ipcRenderer.invoke(IPC.FFMPEG_INSTALL),
    onProgress: (cb: (p: any) => void) => {
      const handler = (_e: any, p: any) => cb(p);
      ipcRenderer.on('ffmpeg:install:progress', handler);
      return () => ipcRenderer.removeListener('ffmpeg:install:progress', handler);
    },
  },

  /* 文件 */
  file: {
    tree: (dir?: string) => ipcRenderer.invoke(IPC.FILE_TREE, dir),
    read: (path: string) => ipcRenderer.invoke(IPC.FILE_READ, path),
    write: (path: string, content: string) => ipcRenderer.invoke(IPC.FILE_WRITE, path, content),
    search: (pattern: string, glob?: string) => ipcRenderer.invoke(IPC.FILE_SEARCH, pattern, glob),
  },

  /* 分析 */
  analyze: {
    file: (path: string) => ipcRenderer.invoke(IPC.ANALYZE_FILE, path),
    workspace: () => ipcRenderer.invoke(IPC.ANALYZE_WORKSPACE),
  },

  /* 修复 */
  patch: {
    apply: (sessionId: string, patch: any) => ipcRenderer.invoke(IPC.PATCH_APPLY, sessionId, patch),
    reject: (sessionId: string, patchId: string) => ipcRenderer.invoke(IPC.PATCH_REJECT, sessionId, patchId),
  },

  /* Git */
  git: {
    status: () => ipcRenderer.invoke(IPC.GIT_STATUS),
    init: () => ipcRenderer.invoke(IPC.GIT_INIT),
    commit: (message: string) => ipcRenderer.invoke(IPC.GIT_COMMIT, message),
    diff: () => ipcRenderer.invoke(IPC.GIT_DIFF),
    push: (remote?: string, branch?: string) => ipcRenderer.invoke(IPC.GIT_PUSH, remote, branch),
  },

  /* 分镜模板 */
  template: {
    list: () => ipcRenderer.invoke(IPC.TEMPLATE_LIST),
  },

  /* 视频引擎 */
  engine: {
    list: () => ipcRenderer.invoke(IPC.ENGINE_LIST),
    set: (kind: string) => ipcRenderer.invoke(IPC.ENGINE_SET, kind),
    probe: () => ipcRenderer.invoke(IPC.ENGINE_PROBE),
    startLocal: () => ipcRenderer.invoke(IPC.ENGINE_START_LOCAL),
    setKey: (kind: string, key: string) => ipcRenderer.invoke(IPC.ENGINE_SET_KEY, kind, key),
    setOption: (opt: any) => ipcRenderer.invoke(IPC.ENGINE_SET_OPTION, opt),
  },

  /* 媒体工作台 */
  media: {
    list: () => ipcRenderer.invoke(IPC.MEDIA_LIST),
    upload: (name: string, dataB64: string) => ipcRenderer.invoke(IPC.MEDIA_UPLOAD, name, dataB64),
    probe: (file: string) => ipcRenderer.invoke(IPC.MEDIA_PROBE, file),
    videoOp: (op: any) => ipcRenderer.invoke(IPC.MEDIA_VIDEO_OP, op),
    extractFrames: (i: string, d: string, e: number, m: number) => ipcRenderer.invoke(IPC.MEDIA_EXTRACT_FRAMES, i, d, e, m),
    extractAudio: (i: string, o: string, f: string) => ipcRenderer.invoke(IPC.MEDIA_EXTRACT_AUDIO, i, o, f),
    mixAudio: (i: string[], o: string, v?: number[]) => ipcRenderer.invoke(IPC.MEDIA_MIX_AUDIO, i, o, v),
    normalize: (i: string, o: string, l?: number) => ipcRenderer.invoke(IPC.MEDIA_NORMALIZE, i, o, l),
    convertImage: (i: string, o: string, op?: any) => ipcRenderer.invoke(IPC.MEDIA_CONVERT_IMAGE, i, o, op),
    grid: (i: string[], o: string, c: number, w: number) => ipcRenderer.invoke(IPC.MEDIA_GRID, i, o, c, w),
    videoGif: (i: string, o: string, w?: number, f?: number) => ipcRenderer.invoke(IPC.MEDIA_VIDEO_GIF, i, o, w, f),
    readDoc: (f: string) => ipcRenderer.invoke(IPC.MEDIA_READ_DOC, f),
  },

  /* 文档 / Excel / 多语言分析 */
  doc: {
    script: (topic: string, kind: string) => ipcRenderer.invoke(IPC.DOC_SCRIPT, topic, kind),
    generate: (md: string, title: string, fmt: string, name?: string) => ipcRenderer.invoke(IPC.DOC_GENERATE, md, title, fmt, name),
  },
  excel: {
    script: (topic: string) => ipcRenderer.invoke(IPC.EXCEL_SCRIPT, topic),
    generate: (md: string, title: string, name?: string) => ipcRenderer.invoke(IPC.EXCEL_GENERATE, md, title, name),
    read: (file: string) => ipcRenderer.invoke(IPC.EXCEL_READ, file),
  },
  analyzeMulti: {
    file: (file: string, content?: string) => ipcRenderer.invoke(IPC.ANALYZE_MULTI, file, content),
    project: () => ipcRenderer.invoke(IPC.ANALYZE_PROJECT),
  },

  /* 批量短视频 */
  batch: {
    add: (topics: string[], engine: string, platform: string) => ipcRenderer.invoke(IPC.BATCH_ADD, topics, engine, platform),
    start: () => ipcRenderer.invoke(IPC.BATCH_START),
    list: () => ipcRenderer.invoke(IPC.BATCH_LIST),
    pause: () => ipcRenderer.invoke(IPC.BATCH_PAUSE),
    resume: () => ipcRenderer.invoke(IPC.BATCH_RESUME),
    cancel: () => ipcRenderer.invoke(IPC.BATCH_CANCEL),
    retry: () => ipcRenderer.invoke(IPC.BATCH_RETRY),
    clear: () => ipcRenderer.invoke(IPC.BATCH_CLEAR),
  },

  /* AI 短视频 */
  video: {
    multi: (script: any, tplIds: string[], sub?: string) => ipcRenderer.invoke(IPC.VIDEO_MULTI, script, tplIds, sub),
    script: (topic: string) => ipcRenderer.invoke(IPC.VIDEO_SCRIPT, topic),
    generate: (script: any, outName?: string) => ipcRenderer.invoke(IPC.VIDEO_GENERATE, script, outName),
  },

  /* 批量进度订阅 */
  onBatchProgress: (cb: (p: any) => void) => {
    const handler = (_e: any, p: any) => cb(p);
    ipcRenderer.on('batch:progress', handler);
    return () => ipcRenderer.removeListener('batch:progress', handler);
  },

  /* Ollama 服务管理（状态 / 启动 / 重启） */
  ollama: {
    status: () => ipcRenderer.invoke(IPC.OLLAMA_STATUS),
    start: (force?: boolean) => ipcRenderer.invoke(IPC.OLLAMA_START, force),
  },

  /* 对话框 */
  dialog: {
    openDir: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR),
    saveFile: (name?: string) => ipcRenderer.invoke(IPC.DIALOG_SAVE_FILE, name),
    /** 在文件管理器中定位文件 */
    showItem: (p: string) => ipcRenderer.send(IPC.DIALOG_SHOW_ITEM, p),
  },

  /* 菜单动作 */
  onMenu: (cb: (action: string) => void) => {
    const handler = (_e: any, action: string) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
