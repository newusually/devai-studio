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

  /* 模型 */
  model: {
    pull: (name: string) => ipcRenderer.invoke(IPC.MODEL_PULL, name),
    recommend: () => ipcRenderer.invoke(IPC.MODEL_RECOMMEND),
    list: (kind?: string) => ipcRenderer.invoke(IPC.MODEL_LIST, kind),
    set: (kind: string, model?: string) => ipcRenderer.invoke(IPC.MODEL_SET, kind, model),
    probe: () => ipcRenderer.invoke(IPC.MODEL_PROBE),
    slots: () => ipcRenderer.invoke(IPC.PROVIDER_LIST),
    setKey: (kind: string, key: string) => ipcRenderer.invoke(IPC.PROVIDER_SET_KEY, kind, key),
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

  /* AI 短视频 */
  video: {
    script: (topic: string) => ipcRenderer.invoke(IPC.VIDEO_SCRIPT, topic),
    generate: (script: any, outName?: string) => ipcRenderer.invoke(IPC.VIDEO_GENERATE, script, outName),
  },

  /* 对话框 */
  dialog: {
    openDir: () => ipcRenderer.invoke(IPC.DIALOG_OPEN_DIR),
    saveFile: (name?: string) => ipcRenderer.invoke(IPC.DIALOG_SAVE_FILE, name),
  },

  /* 菜单动作 */
  onMenu: (cb: (action: string) => void) => {
    const handler = (_e: any, action: string) => cb(action);
    ipcRenderer.on('menu:action', handler);
    return () => ipcRenderer.removeListener('menu:action', handler);
  },
};

contextBridge.exposeInMainWorld('api', api);
