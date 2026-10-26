# DevAI Studio

> 免费开源的本地 AI 编程助手 —— 对话式写代码、自动识别错误并修复、代码分析、多 Agent 协作、自动学习。
> **完全免费、离线可用、代码不出本机。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub release](https://img.shields.io/badge/release-v1.1.0-blue)](https://github.com/newusually/devai-studio/releases)
[![Downloads](https://img.shields.io/github/downloads/newusually/devai-studio/total)](https://github.com/newusually/devai-studio/releases)
[![Electron](https://img.shields.io/badge/Electron-45-blue.svg)](https://electronjs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5-blue.svg)](https://typescriptlang.org)

---

## 一、它能做什么

| 能力 | 说明 |
|------|------|
| **对话式写代码** | 中文对话，AI 读你的文件、改你的代码、给你 diff 预览 |
| **自动识别错误** | 内置静态分析引擎（**不消耗任何模型额度**），找出语法错误、未使用变量、缺失导入、硬编码密钥等 30+ 类问题 |
| **确认后自动修** | AI 给出 diff，你点「应用修改」才写盘，支持一键回滚 |
| **13 种专业 Agent** | 通用/代码审查/调试/架构/测试/重构/文档/SQL/接口设计/翻译/**短视频文案**/学习教练/提交助手 |
| **自动学习** | 自动分析你的项目风格、积累踩过的坑、记住术语 —— 越用越懂你 |
| **GPU / CPU 自适应** | **有独立显卡就用 GPU（显存拉满 + CPU 辅助）；没有就自动用满全部 CPU 核**，无需手动配置 |
| **内置模型（开箱即用）** | 安装包自携带 DeepSeek-R1 1.5B 轻量推理模型，装完离线即可对话 |
| **按需下载模型** | 不强制立刻下载；下拉可选任意模型，点选即按「残血版」轻量下载 |
| **会话管理** | 多会话、历史搜索、导入导出，本地 SQLite 存储 |
| **Git 集成** | 初始化、状态、差异、提交、一键推送到 GitHub |
| **本地优先** | 本地模型离线运行，代码永不上传；可选免费云端额度作为补充 |

---

## 二、快速开始（两台电脑都适用）

### 方式 A：直接用安装包（推荐给两台电脑）

1. 从 GitHub **Releases** 页面下载 `DevAI-Studio-Setup-1.0.0-x64.exe`
2. 双击安装 → 自动创建 **桌面快捷方式** + **开始菜单项** + 应用图标
3. 安装包**自带 Ollama 运行时 + DeepSeek-R1 1.5B 内置模型**，装完即用、离线可跑
4. 首次打开会自动创建工作区 `文档\DevAI-Workspace`

> 💡 所有快捷方式都指向原生启动器 `launcher.exe`，它会在启动前清除会让 Electron 变成纯 Node 的污染环境变量，保证应用**必定以桌面程序启动**，永不退化成黑窗口/命令行。

### 方式 B：从源码运行

```bash
# 需要 Node.js 20+ 与 npm
npm install
npm run build
npm start
```

### 安装更多本地模型（免费、离线、按需）

软件内置了模型库面板（左侧「📦 模型库」），**想下哪个点哪个**，默认推荐文字【残血版】（同族最轻量，8G 内存也能跑），也可手动选完整版。

![模型库](docs/screenshot-model-lib.png)

也可以用命令行（对本机已有的独立 Ollama）：

```bash
# 推荐组合（8GB 内存机器）
ollama pull qwen3:4b          # 中文强，2.5GB，4GB 内存起步
ollama pull qwen2.5-coder:7b   # 代码专用，4.7GB

# 英文任务
ollama pull llama3.2:3b       # 2.0GB
ollama pull deepseek-r1:1.5b  # 内置的轻量推理模型，1.1GB
```

> **8GB 内存 + 无独显的推荐档位**：`qwen3:8b`（通用+中文）或`qwen2.5-coder:7b`（纯代码）。
> 推理速度约 8-12 tok/s，日常足够。

---

## 三、硬件自适应（重点新特性）

DevAI Studio 会在启动和首次对话时自动探测本机硬件，然后**自动把推理参数调到接近该机上限**，无需任何人工配置：

| 场景 | 自动行为 |
|------|---------|
| **有独立显卡（NVIDIA 有显存）** | 模型放进显存（GPU 加速），同时留一半 CPU 核心做辅助编码 → 速度拉满 |
| **无独立显卡（纯 CPU）** | 用满**全部 CPU 核心**（不再砍半），把 CPU 推理榨到最高 |
| **核数少 / 内存小** | 自动提示推荐用 ≤7B 模型，避免 OOM |

- 探测结果会显示在**引擎设置**里（GPU 名称、显存、核心数、内存、采用策略）。
- 你也可以在**引擎设置**里手动指定线程数；一旦手动设置，就不再被自动覆盖。
- `num_ctx` 默认 4096、`keep_alive` 3 分钟、KV 缓存 `q8_0`、单并发 —— 专为低配置机器压内存、防 OOM。

> 无 GPU 的机器本来就会比硬件强（多核/显卡）慢，这是物理限制。
> 本软件已经把你机器的每一分 CPU 都利用起来，问大模型不会再「卡到转圈」。

---

## 四、免费模型来源一览

全部**不需要付费、不需要绑卡**：

| 来源 | 免费额度 | 特点 |
|------|---------|------|
| **Ollama 本地** | 完全免费 · 无限量 · 离线可用 | 支持 GPU / CPU 自适应；中文首选 Qwen3 / DeepSeek |
| **OpenRouter** | 免费模型 $0/token · 20 次/分 · 50 次/天 | 模型 id 带 `:free`，推荐 `openrouter/free` 自动路由 |
| **Gemini** | 免费层约 1500 次/天 · 上下文 1M | 长文档分析 |
| **Groq** | 30 次/分 · 1000 次/天 | LPU 推理，Llama 3.3 70B 约 320 tok/s |
| **自定义端点** | 取决于你 | 任何 OpenAI 兼容服务（vLLM / llama.cpp / LM Studio） |

免费密钥申请地址：
- OpenRouter → https://openrouter.ai/keys
- Gemini → https://aistudio.google.com/app/apikey
- Groq → https://console.groq.com/keys

---

## 五、技术架构

```
┌─────────────────────────────────────────────────┐
│  Electron 主进程 (src/main)                     │
│   ├── hardware.ts        ★硬件自适应(GPU/CPU/核心)│
│   ├── providers/        多模型来源统一抽象        │
│   │    ├── ollama.ts     ★本地(Ollama)+GPU/CPU自适应│
│   │    ├── openai-compatible.ts  OpenRouter/Groq │
│   │    ├── gemini.ts        Google 免费层        │
│   │    └── index.ts       Provider 注册中心       │
│   ├── agents/                                    │
│   │    ├── agent.ts      Agent 主循环            │
│   │    ├── roles.ts      13 种专业角色           │
│   │    └── tools.ts      工具集（沙箱+白名单）   │
│   ├── analysis/linter.ts 本地静态分析引擎         │
│   ├── memory.ts          自动学习记忆库           │
│   ├── store.ts         会话持久化 (node:sqlite)  │
│   └── git.ts            Git 服务                 │
├─────────────────────────────────────────────────┤
│  preload (src/preload)   contextBridge 安全桥接  │
│   渲染进程拿不到 API Key 明文，也拿不到 Node 能力 │
├─────────────────────────────────────────────────┤
│  React 渲染层 (src/renderer)                     │
│   ├── App.tsx          三栏布局                  │
│   ├── ChatPane.tsx     对话流 + diff 视图         │
│   ├── AgentBar.tsx     角色/模型库/学习面板       │
│   ├── SessionList.tsx    会话列表                │
│   └── SettingsModal.tsx  模型来源设置            │
└─────────────────────────────────────────────────┘
```

### 原生启动器

| 文件 | 作用 |
|------|------|
| `build/launcher.cpp` → `launcher.exe` | **桌面/开始菜单快捷方式指向它**；启动前清除 `ELECTRON_RUN_AS_NODE`，保证应用以 Electron 模式启动、不弹黑窗 |
| `build/nowin.c` → `nowin.exe` | **包裹 Ollama 进程**，用 `CREATE_NO_WINDOW` 让 ollama→llama-server 后代进程**不分配可见控制台**，根除启动时弹黑窗口 |

> 编译：MinGW-w64 16.2.0（`g++ -O2 -mwindows -static -o launcher.exe launcher.cpp` / `gcc -O2 -mwindows -o nowin.exe nowin.c -lshell32`）。

---

## 六、安全设计

| 措施 | 说明 |
|------|------|
| 路径沙箱 | 所有文件操作必须在工作区内，防目录穿越 |
| 命令白名单 | 只有 `node/npm/git/python/tsc/eslint` 等允许执行 |
| 密钥隔离 | API Key 只在主进程，渲染进程永远拿不到明文 |
| 修改确认 | AI 的修改先给 diff，用户确认才写盘 |
| 回滚 | 一键还原到修改前的内容 |
| 上下文隔离 | `contextIsolation: true`，渲染进程无 Node 能力 |

---

## 七、自动学习机制

（全部本地，存储于 `<工作区>/.devai/memory.json`）：
自动分析项目语言分布/技术栈/构建工具，提炼编码风格（缩进/引号/分号/注释语言），记录**踩过的坑**（反复出现的错误位置下次优先提醒），维护术语表，记录使用偏好。文件可随项目提交到 Git，团队共享。

---

## 八、开发

```bash
npm run dev          # 开发模式（Vite HMR + tsc watch）
npm run build        # 编译主进程 + 渲染层
npm run dist         # 打 Windows NSIS 安装包 → release/（含内置模型）
npm run dist:dir     # 打免安装目录版
npm run typecheck    # 类型检查
npm run lint         # ESLint
```

### 目录结构

```
src/
├── main/           主进程
├── preload/        安全桥接
├── renderer/       React 界面
├── shared/         类型契约（主进程/渲染进程共用）
└── types/          手写类型声明
build/
├── launcher.cpp    原生启动器（快捷方式目标）
└── nowin.c         无窗口启动器（防 ollama 黑窗口）
resources/
├── models/         内置模型（DeepSeek-R1 1.5B，随安装包分发）
├── ollama/         Ollama 运行时（随安装包分发，构建时从本机复制，不入 Git）
└── skills/         技能包
scripts/
├── bundle-ollama.js 打包前复制 Ollama 运行时
└── install/nsh       NSIS 快捷方式片段
```

---

## 九、常见问题

**Q: 界面卡在「正在启动」？**
A: 多半是 `ELECTRON_RUN_AS_NODE=1` 环境污染。用安装分包自带的**桌面快捷方式**（走 `launcher.exe`）启动即可，它会自动清除该变量封死回退化。

**Q: 模型推理还是慢 / 转圈？**
A: 先看**引擎面板**的硬件检测结论：
- 若无独立显卡 → 纯 CPU 推理，已自动用满全部核心（这是物理上限，非软件问题）；
- 建议选择 ≤7B 模型；DeepSeek-R1 这类推理链模型思考阶段本身就慢（它会想很久再答）。
- 或改配图免费云端额度（OpenRouter/Gemini/Groq）作为补充。

**Q: 为什么默认拉的是「残血版」模型？**
A: 为照顾 8G 内存 / 无独显机器，下载按钮默认给你**同族最轻量的版本**（Qwen3-0.6B、DeepSeek-R1 1.5B 等），保证能装上、能跑起来。需要更强再手动选完整版。

**Q: 模型下载总是失败？**
A: 多为残留的半拉模型 manifest 阻塞了重新拉取。在模型库点下载失败后，去模型目录删掉 `manifests/registry.ollama.ai/library/<模型名>` 再重拉即可。

**Q: 程序已自带模型，还要装 Ollama？**
A: 不用——安装包已内置 **Ollama 运行时**（`resources/ollama`）与模型，装完直接可用、离线可跑。若你机器上另外装过标准 Ollama，软件会优先用你那个（已有更多模型）。

**Q: 会话数据在哪？**
A: `%APPDATA%\DevAIStudio\data\devai.db`（SQLite，WAL 模式）。

---

## 十、下载

前往 [Releases 页面](https://github.com/newusually/devai-studio/releases) 下载安装包：

- `DevAI-Studio-Setup-1.0.0-x64.exe` —— Windows 安装版（含内置 Ollama + DeepSeek-R1 1.5B 模型、原生启动器、桌面+开始菜单快捷方式）
- 源码随 **Git 仓库**同步：https://github.com/newusually/devai-studio （`src/` 面向开发调试）

## 十一、许可证

MIT —— 完全免费，可商用、可修改、可闭源分发。
模型权重各有独立许可证（Qwen3 = Apache 2.0，Llama = Llama Community，DeepSeek-R1 = MIT 等），均为免费可商用。