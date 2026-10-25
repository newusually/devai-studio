/* ============================================================================
 * renderer/api.d.ts —— window.api 的类型声明
 * ========================================================================== */
import { IPC, ProviderKind, StreamEvent } from '../shared/types';

export interface AppInfo {
  version: string;
  electron: string;
  node: string;
  platform: string;
  workspace: string;
  dataDir: string;
  provider: {
    kind: ProviderKind;
    name: string;
    baseUrl: string;
    model: string;
    local: boolean;
    freeQuota?: string;
  };
  slots: Array<{
    kind: ProviderKind;
    name: string;
    baseUrl: string;
    defaultModel: string;
    needsKey: boolean;
    freeQuota: string;
    local: boolean;
    docsUrl: string;
    hint: string;
  }>;
}

export interface SlotInfo {
  kind: ProviderKind;
  name: string;
  baseUrl: string;
  defaultModel: string;
  needsKey: boolean;
  freeQuota: string;
  local: boolean;
  docsUrl: string;
  hint: string;
  override: { baseUrl?: string; model?: string; apiKey?: string };
  hasKey: boolean;
}

export interface ModelRow {
  id: string;
  provider: ProviderKind;
  name: string;
  size?: string;
  quantization?: string;
  contextLength?: number;
  local: boolean;
  free: boolean;
  downloaded?: boolean;
}

declare global {
  interface Window {
    api: {
      appInfo(): Promise<AppInfo>;
      session: {
        list(): Promise<any[]>;
        create(title?: string): Promise<any>;
        get(id: string): Promise<any>;
        remove(id: string): Promise<boolean>;
        rename(id: string, title: string): Promise<boolean>;
        export(id: string): Promise<any>;
      };
      chat: {
        send(sessionId: string, text: string): Promise<any>;
        abort(sessionId: string): Promise<any>;
        onStream(cb: (e: StreamEvent) => void): () => void;
      };
      role: {
        list(): Promise<Array<{ id: string; name: string; icon: string; desc: string; tools: string[]; preferModels: string[] }>>;
        set(id: string): Promise<any>;
      };
      memory: {
        get(): Promise<any>;
        clear(): Promise<any>;
        learnFile(path: string): Promise<any>;
      };
      model: {
        pull(name: string): Promise<{ ok: boolean; output?: string; error?: string }>;
        recommend(): Promise<Array<{ name: string; size: string; mem: string; lang: string; use: string }>>;
        list(kind?: string): Promise<Array<{ kind: ProviderKind; models: ModelRow[] }>>;
        set(kind: string, model?: string): Promise<any>;
        probe(): Promise<Array<{ kind: ProviderKind; ok: boolean; message: string; latencyMs?: number }>>;
        slots(): Promise<SlotInfo[]>;
        setKey(kind: string, key: string): Promise<any>;
      };
      file: {
        tree(dir?: string): Promise<any>;
        read(path: string): Promise<any>;
        write(path: string, content: string): Promise<any>;
        search(pattern: string, glob?: string): Promise<any>;
      };
      analyze: {
        file(path: string): Promise<any>;
        workspace(): Promise<{ diagnostics: any[]; count: number }>;
      };
      patch: {
        apply(sessionId: string, patch: any): Promise<any>;
        reject(sessionId: string, patchId: string): Promise<any>;
      };
      git: {
        status(): Promise<any>;
        init(): Promise<any>;
        commit(message: string): Promise<any>;
        diff(): Promise<any>;
        push(remote?: string, branch?: string): Promise<any>;
      };
      video: {
        script(topic: string): Promise<any>;
        generate(script: any, outName?: string): Promise<any>;
      };
      dialog: {
        openDir(): Promise<string | null>;
        saveFile(name?: string): Promise<string | null>;
      };
      onMenu(cb: (action: string) => void): () => void;
    };
  }
}

export {};
