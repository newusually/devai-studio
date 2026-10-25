# DevAI Studio

> 免费开源的本地 AI 编程助手 —— 对话式写代码、自动识别错误并修复、代码分析、多 Agent 协作、自动学习。
> **完全免费、离线可用、代码不出本机。**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
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
| **模型库** | 12 个免费开源模型一键下载，含中文强（Qwen3）与英文强（Llama/Gemma/Phi4） |
| **会话管理** | 多会话、历史搜索、导入导出，本地 SQLite 存储 |
| **Git 集成** | 初始化、状态、差异、提交、一键推送到 GitHub |
| **本地优先** | 本地模型离线运行，代码永不上传；可选免费云端额度作为补充 |

---

## 二、快速开始（两台电脑都适用）

### 方式 A：直接用安装包（推荐给两台电脑）

1. 从 `release/` 拿 `DevAI-Studio-Setup-1.0.0-x64.exe`
2. 双击安装 → 自带桌面快捷方式 + 开始菜单项 + 应用图标
3. 首次打开会自动创建工作区 `文档\DevAI-Workspace`

### 方式 B：从源码运行

```bash
# 需要 Node.js 20+ 与 npm
npm install
npm run build
npm start
```

### 安装本地模型（免费、离线）

软件内置了模型库面板（左侧「📦 模型库」），点「下载」即可。
也可以用命令行：

```bash
# 推荐组合（8GB 内存机器）
ollama pull qwen3:4b          # 中文强，2.5GB，4GB 内存起步
ollama pull qwen2.5-coder:7b   # 代码专用，4.7GB

# 英文任务
ollama pull llama3.2:3b       # 2.0GB
ollama pull gemma2:2b          # 1.6GB
```

> **8GB 内存 + 4 核无 GPU 的推荐档位**：`qwen3:4b`（通用+中文）或 `qwen2.5-coder:7b`（纯代码）。
> 推理速度约 8-15 tok/s，日常够用。

---

## 三、免费模型来源一览

全部**不需要付费、不需要绑卡**：

| 来源 | 免费额度 | 特点 |
|------|---------|------|
| **Ollama 本地** | 完全免费 · 无限量 · 离线可用 | 中文首选 Qwen3，英文 Llama/Gemma/Phi4 |
| **OpenRouter** | 免费模型 $0/token · 20 次/分 · 50 次/天 | 模型 id 带 `:free`，推荐 `openrouter/free` 自动路由 |
| **Google Gemini** | 免费层约 1500 次/天 · 上下文 1M | 长文档分析 |
| **Groq** | 30 次/分 · 1000 次/天 | LPU 推理，Llama 3.3 70B 约 320 tok/s |
| **自定义端点** | 取决于你 | 任何 OpenAI 兼容服务（vLLM / llama.cpp / LM Studio） |

免费密钥申请地址：
- OpenRouter → https://openrouter.ai/keys
- Gemini → https://aistudio.google.com/app/apikey
- Groq → https://console.groq.com/keys

---

## 四、技术架构

与 WorkBuddy / CodeBuddy 同构的设计思路：

```
┌─────────────────────────────────────────────────┐
│  Electron 主进程 (src/main)                     │
│   ├── providers/     多模型来源统一抽象          │
│   │    ├── ollama.ts          本地免费模型       │
│   │    ├── openai-compatible.ts  OpenRouter/Groq │
│   │    ├── gemini.ts          Google 免费层      │
│   │    └── index.ts           Provider 注册中心   │
│   ├── agents/                                          │
│   │    ├── agent.ts         Agent 主循环          │
│   │    ├── roles.ts         13 种专业角色         │
│   │    └── tools.ts         工具集（沙箱+白名单） │
│   ├── analysis/linter.ts   本地静态分析引擎       │
│   ├── memory.ts            自动学习记忆库         │
│   ├── store.ts             会话持久化 (node:sqlite)│
│   └── git.ts               Git 服务               │
├─────────────────────────────────────────────────┤
│  preload (src/preload)   contextBridge 安全桥接   │
│   渲染进程拿不到 API Key 明文，也拿不到 Node 能力  │
├─────────────────────────────────────────────────┤
│  React 渲染层 (src/renderer)                      │
│   ├── App.tsx             三栏布局                │
│   ├── ChatPane.tsx        对话流 + diff 视图       │
│   ├── AgentBar.tsx        角色/模型库/学习面板     │
│   ├── SessionList.tsx     会话列表                │
│   ├── SidePanel.tsx       诊断/文件/Git           │
│   └── SettingsModal.tsx   模型来源设置            │
└─────────────────────────────────────────────────┘
```

### 与 WorkBuddy 的对应关系

| WorkBuddy | DevAI Studio |
|-----------|--------------|
| Electron GUI | Electron 45 GUI |
| CodeBuddy CLI（TS/Node） | `src/main`（TS/Node） |
| `ink` TUI | React 渲染层 |
| `@openai/agents` + MCP SDK | 自研 Agent 循环 + 工具集 |
| 内置模型网关 | 多 Provider 抽象层 |
| `node:sqlite` | `node:sqlite`（同款） |
| Skills / Plugins | 角色系统 + 工具集 |

> **没有用 C++ / Python** —— WorkBuddy 本身也没用。
> CLI 内核是 TypeScript/Node，GUI 是 Electron。原生部分只有少量 DLL（性能采集、企微解码），
> 与 AI 编程主链路无关。

---

## 五、安全设计

| 措施 | 说明 |
|------|------|
| 路径沙箱 | 所有文件操作必须在工作区内，防目录穿越 |
| 命令白名单 | 只有 `node/npm/git/python/tsc/eslint` 等允许执行 |
| 密钥隔离 | API Key 只在主进程，渲染进程永远拿不到明文 |
| 修改确认 | AI 的修改先给 diff，用户确认才写盘 |
| 回滚 | 一键还原到修改前的内容 |
| 上下文隔离 | `contextIsolation: true`，渲染进程无 Node 能力 |

---

## 六、自动学习机制

软件会自动积累（全部本地，存 `<工作区>/.devai/memory.json`）：

- **项目画像**：语言分布、技术栈、构建工具
- **编码风格**：缩进、引号、分号、注释语言 → 生成代码自动遵循
- **踩过的坑**：反复出现的错误位置 → 下次优先提醒
- **术语表**：项目专有名词 → 保持用词一致
- **使用偏好**：常用哪个角色、哪种工作流

文件可随项目提交到 Git，团队共享。

---

## 七、开发

```bash
npm run dev          # 开发模式（Vite HMR + tsc watch）
npm run build        # 编译主进程 + 渲染层
npm run dist         # 打 Windows 安装包 → release/
npm run dist:dir     # 打免安装目录版
npm run typecheck    # 类型检查
```

### 目录结构

```
src/
├── main/           主进程
│   ├── providers/  模型来源
│   ├── agents/     Agent 循环 + 角色 + 工具
│   ├── analysis/   静态分析引擎
│   ├── memory.ts   自动学习
│   ├── store.ts    会话存储
│   └── git.ts      Git 服务
├── preload/        安全桥接
├── renderer/       React 界面
├── shared/         类型契约（主进程/渲染进程共用）
└── types/          手写类型声明
```

---

## 八、常见问题

**Q: 界面卡在"正在启动"？**
A: 多半是 `ELECTRON_RUN_AS_NODE=1` 环境变量导致 Electron 退化成纯 Node。
用 `scripts/start.cmd` 启动（已自动清除该变量）。

**Q: 菜单显示英文？**
A: Electron 内置菜单默认英文。本项目已逐项覆盖为中文，
若仍显示英文说明跑的是旧版本，执行 `npm run build` 重新构建。

**Q: 模型推理很慢？**
A: 无 GPU 时是 CPU 推理。8G 机器请用 `qwen3:4b`；
也可以在设置里配免费云端额度做补充。

**Q: 会话数据在哪？**
A: `%APPDATA%\DevAI Studio\data\devai.db`（SQLite，WAL 模式）。

---

## 九、许可证

MIT —— 完全免费，可商用、可修改、可闭源分发。

模型权重各有独立许可证（Qwen3 = Apache 2.0，Llama = Llama Community，Qwen2.5-Coder = Apache 2.0 等），
均为免费可商用。
