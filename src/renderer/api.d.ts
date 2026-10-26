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
  /** 深度思考（Qwen3 thinking）是否开启 */
  thinking: boolean;
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
      buddyMemory: {
        get(fresh?: boolean): Promise<{
          ok: boolean;
          error?: string;
          projectFiles: Array<{ path: string; kind: string; mtime: number; size: number; date?: string }>;
          userFiles: Array<{ path: string; kind: string; mtime: number; size: number; date?: string }>;
          brief: string;
          raw: string;
        }>;
      };
      model: {
        pull(name: string): Promise<{ ok: boolean; output?: string; error?: string }>;
        recommend(): Promise<{
          models: Array<{ name: string; size: string; mem: string; lang: string; use: string; verified?: boolean }>;
          bigModels: Array<{ name: string; params: string; local: string; cloud: string; note: string }>;
        }>;
        list(kind?: string): Promise<Array<{ kind: ProviderKind; models: ModelRow[] }>>;
        set(kind: string, model?: string): Promise<any>;
        probe(): Promise<Array<{ kind: ProviderKind; ok: boolean; message: string; latencyMs?: number }>>;
        slots(): Promise<SlotInfo[]>;
        setKey(kind: string, key: string): Promise<any>;
        setThinking(on: boolean): Promise<{ ok: boolean; thinking: boolean }>;
      };
      ollama: {
        status(): Promise<{ up: boolean; running: boolean; exe: string | null; modelsDir: string; boot: any; port: string }>;
        start(force?: boolean): Promise<{ ok: boolean; up: boolean; message: string }>;
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
      template: {
        list(): Promise<any>;
      };
      engine: {
        list(): Promise<any>;
        set(kind: string): Promise<any>;
        probe(): Promise<any>;
        startLocal(): Promise<any>;
        setKey(kind: string, key: string): Promise<any>;
        setOption(opt: any): Promise<any>;
      };
      media: {
        list(): Promise<any[]>;
        upload(name: string, dataB64: string): Promise<any>;
        probe(file: string): Promise<any>;
        videoOp(op: any): Promise<any>;
        extractFrames(i: string, d: string, e: number, m: number): Promise<any>;
        extractAudio(i: string, o: string, f: string): Promise<any>;
        mixAudio(i: string[], o: string, v?: number[]): Promise<any>;
        normalize(i: string, o: string, l?: number): Promise<any>;
        convertImage(i: string, o: string, op?: any): Promise<any>;
        grid(i: string[], o: string, c: number, w: number): Promise<any>;
        videoGif(i: string, o: string, w?: number, f?: number): Promise<any>;
        readDoc(f: string): Promise<any>;
      };
      doc: {
        script(topic: string, kind: string): Promise<any>;
        generate(md: string, title: string, fmt: string, name?: string): Promise<any>;
      };
      excel: {
        script(topic: string): Promise<any>;
        generate(md: string, title: string, name?: string): Promise<any>;
        read(file: string): Promise<any>;
      };
      analyzeMulti: {
        file(file: string, content?: string): Promise<any>;
        project(): Promise<any>;
      };
      batch: {
        add(topics: string[], engine: string, platform: string): Promise<any>;
        start(): Promise<any>;
        list(): Promise<any>;
        pause(): Promise<any>;
        resume(): Promise<any>;
        cancel(): Promise<any>;
        retry(): Promise<any>;
        clear(): Promise<any>;
      };
      onBatchProgress(cb: (p: any) => void): () => void;
      video: {
        multi(script: any, tplIds: string[], sub?: string): Promise<any>;
        script(topic: string): Promise<any>;
        generate(script: any, outName?: string): Promise<any>;
      };
      dialog: {
        openDir(): Promise<string | null>;
        saveFile(name?: string): Promise<string | null>;
        showItem(p: string): void;
      };
      onMenu(cb: (action: string) => void): () => void;
    };
  }
}

export {};
