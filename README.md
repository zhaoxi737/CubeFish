# QDOQMC

AI 驱动的《我的世界》启动器。一个启动按钮 + 一个 AI 聊天框：说一句话，它把模组 / 光影 / 资源包 / 整合包下好、装进正确的实例，然后一键开玩。

> 当前状态：**P0–P29 全部完成并实测**（Fabric / Forge / NeoForge、整合包、插件市场、微软登录、AI 助手、实例迁移、PCL 式下载中心、界面按 PCL 重组）。
> 商业策略：先免费做口碑，但架构上把「收费的缝」全部预留好（见 [docs/PLAN.md](docs/PLAN.md)）。
> 维护者请先看 [docs/MAINTAIN.md](docs/MAINTAIN.md)（维护节奏、上游依赖、发版流程、排障速查）。

## 它现在能做什么

| 能力 | 说明 |
|---|---|
| **一键装游戏** | Mojang 原版任意版本 + 自动匹配/下载 Java 运行时，sha1 校验、断点可续（下载缓存命中） |
| **PCL 式下载中心（P29）** | 独立页面 + 左侧分类（游戏 / 模组 / 资源包 / 光影 / 整合包 / 下载任务），搜索、来源过滤、点开看图片预览；主界面不再堆下载控件 |
| **版本 ↔ 加载器兼容（P28/P29）** | 选一个游戏版本就知道它能配哪些加载器：Fabric / Forge / NeoForge 推荐版本 + 可选版本数，一次装好并自动绑定当前实例；某个上游挂了只显示「查询超时」，不拖住整个面板 |
| **逐文件下载进度（P29）** | 下载任务页按 PCL 的方式列出每个文件的状态（✓ 完成 / ▶ 下载中 / ○ 等待 / ✕ 失败）+ 大小 + 总速度 + 剩余时间，可取消；原版安装与整合包（`.mrpack` / CurseForge）都覆盖 |
| **整合包进度（P29）** | 整合包几十个文件的下载终于有进度条和文件清单，不再只有一句 toast |
| **资源/光影预览 + 模组更新检查（P29）** | 点任意项目看 Modrinth 画廊图；已装模组一键检查更新（sha1 批量比对）、单个更新（先下后删、失败回滚） |
| **下载加速（P28）** | 国内镜像 BMCLAPI 与官方源自动测速选快的；大文件分片并发下载，服务端不支持 Range 自动回退单流 |
| **三大加载器** | Fabric、Forge（1.20.1 实测）、NeoForge（1.21.11 实测），装完直接启动 |
| **模组 / 资源包 / 光影** | 面板里搜 Modrinth 直接装；每个结果标出它支持的 MC 版本/加载器，不匹配的置灰；按实例隔离，冲突静态分析 + 缺失前置提示 |
| **整合包** | `.mrpack`（Modrinth）与 CurseForge `.zip`；自动装对应加载器，支持本机文件预览/安装 |
| **多实例** | 每实例独立 mods/存档/配置，独立内存分配，可绑定不同微软账号；支持导出/导入 zip |
| **微软正版登录** | OAuth 设备码 → Xbox Live → Minecraft Services；令牌用 Windows DPAPI 加密存储，支持多账号 |
| **AI 助手** | 自然语言 → 工具调用：装模组、查冲突、看崩溃、开游戏；流式输出 + 会话记忆（本机） |
| **崩溃归因 + 一键修复** | 内置规则库识别依赖缺失/Mixin/OOM/驱动问题，直接给可点击的修复动作 |
| **插件系统** | 复用 Harness 的 Cordis 内核；插件跑在**独立子进程 + Node permission model** 沙箱里，可注册 AI 工具/聊天命令 |
| **插件市场** | 静态 feed + Ed25519 签名校验 + sha256 校验的一键安装 |
| **自动更新** | 静态 latest.json 清单 + sha256 校验，退出后替换并自动重启（已在真机 0.1.0 → 0.2.0 演练） |
| **界面** | 按 PCL 布局重组：左侧版本列表 + 中间版本卡片/启动按钮/四个快捷入口 + 右侧 AI 助手；背景用你自己给的那张图（`art/bg-user.jpg`），大肥鱼吉祥物与草地纹理由本机 ComfyUI 生成（见 [art/README.md](art/README.md)） |
| **可观测** | 结构化 JSONL 日志、事件埋点、游戏日志在应用内直接查看（ERROR/WARN 高亮，2 秒刷新） |

## 运行

### 打包版（普通用户）

双击 `dist/QDOQMC-win32-x64/QDOQMC.exe`，不需要 Node/npm。
分发包：`dist/QDOQMC-0.1.0-win32-x64.zip`（约 138MB，含 Electron 运行时）。

### 开发模式

```bash
npm install
npm run build
npm start           # 打开启动器
npm run smoke       # 自动冒烟：截图 + 走一遍 UI/IPC/整合包安装，结果打印到 stdout
npm run typecheck
npm run package     # 生成便携版 + latest.json
```

要求：Node 22+，Windows 10/11。

### 不填 API Key 也能用

- 装游戏 / 装模组 / 冲突检查 / 崩溃归因 / 本地日志：全部离线可用；
- AI 自然语言需要用户在「设置 → 模型 API Key」填自己的 Key（DeepSeek 或任意 OpenAI 兼容端点）；
- 微软登录需要用户自备 Azure 公共客户端 `client_id`（不内置，避免冒用发行方资质）。

## 架构

```
Electron 主进程
  └─ Cordis 插件内核（kernel.ts，26 个插件按依赖顺序装配）
       ├─ 基础：app / paths / logger / settings / storage / identity / auth / entitlement / cloud / telemetry / updater
       ├─ 游戏：mojang / java / instances / loaders / launch
       ├─ 内容：content（Modrinth + .mrpack + CurseForge）/ conflict / diagnose / market
       ├─ AI：llm / tools / agent / chat
       └─ 扩展：plugin-host（子进程沙箱）/ ipc
```

- 主进程与界面之间只有 `window.qdo` 一层 contextBridge；
- 插件契约：`definePlugin(name, setup)`，通过 `ctx.provide / use<T>` 取服务；
- 插件沙箱：`child_process.fork` + `ELECTRON_RUN_AS_NODE=1` + Node `--permission`
  （只能读插件自己的目录，禁止写盘 / `child_process`），崩溃不拖死主进程。

## 目录结构

```
src/
  main/              主进程（Cordis 插件内核）
    kernel.ts        插件装配与生命周期
    plugin-kit.ts    插件契约
    plugin-worker.ts 插件沙箱 worker
    plugins/         26 个内置插件
  preload/           contextBridge 暴露 window.qdo
  renderer/          React 界面
  shared/            共用类型 / IPC 通道 / 版本比较
scripts/             esbuild 构建、打包、更新清单、mock LLM / mock 授权 / mock CurseForge
samples/plugins/     示例插件
docs/                计划、开发手册、插件指南
```

## 文档

- [总计划（需求 / 架构 / 商业化预留 / 里程碑 / 风险）](docs/PLAN.md)
- [开发手册（运行、CLI、插件、数据目录、P0–P25 验收表与总矩阵）](docs/DEV.md)
- [插件开发指南（写一个插件并让 AI 能调用 + 市场 feed 格式）](docs/PLUGINS.md)

## 数据目录

`%APPDATA%\QDOQMC\`：`instances/`（每实例 `.minecraft`）、`libraries/`、`assets/`、`versions/`、
`runtimes/`、`downloads/`（内容寻址缓存）、`plugins/`、`accounts.json`（DPAPI 加密）、`logs/`。

## 已知限制

- **更新**：只支持便携版解压替换；NSIS 安装包与代码签名未做（SmartScreen 会提示未知发布者）。
- **加载器**：更老的 Forge（1.12.2 等）未验证；Quilt 明确不支持。
- **CurseForge**：需要用户自备 API Key（包内自带 mods 的离线包免 Key）。
- **插件网络**：Node permission model 不管网络，插件联网仍靠 manifest `net` 声明 + 来源审核。
- **AI**：真实模型需用户自填 Key；多会话/跨实例记忆未做。
- **账号**：令牌加密绑定当前 Windows 用户（DPAPI），换用户/换机需重新登录。

## 核心原则

1. 极简是默认路径最短，不是功能少。
2. 一切皆插件（复用 Harness 的 Cordis 内核），AI 能给自己加功能。
3. AI 走结构化工具，不拼下载链接、不编造事实。
4. 日志是地基：每次启动、每次崩溃都可归因。
5. 用户 API Key / 账号令牌只存本机；统计数据匿名、可关闭。
