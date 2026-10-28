# QDOQMC

AI 驱动的《我的世界》启动器。一个大启动按钮 + 一个 AI 聊天框：说一句话，它把模组/光影/整合包下好、装进正确实例，然后一键开玩。

> 当前状态：**P5「能长」完成**——第三方插件可在运行时加载/卸载并注册新的 AI 工具与聊天命令；配合 P4 的自然语言工具调用，AI 真的能给启动器加功能。
> 商业策略：先免费做口碑，但架构上把「收费的缝」全部预留好。

## 文档

- [总计划（需求 / 架构 / 商业化预留 / 里程碑 / 风险）](docs/PLAN.md)
- [开发手册（运行、插件、数据目录、验收）](docs/DEV.md)
- [插件开发指南（写一个插件并让 AI 能调用）](docs/PLUGINS.md)

## 运行

```bash
npm install
npm run build
npm start          # 打开启动器
npm run smoke      # 自动冒烟：截图 + 点击启动 + 走一次 IPC，结果打印到 stdout
npm run typecheck  # 类型检查
```

要求：Node 22+，Windows 10/11。

## 目录结构

```
src/
  main/            主进程（Cordis 插件内核）
    kernel.ts      插件装配与生命周期
    plugin-kit.ts  插件契约
    plugins/       13 个基础插件（见 docs/DEV.md）
  preload/         contextBridge 暴露 window.qdo
  renderer/        React 极简界面
  shared/          主进程与界面共用的类型 / 通道 / 版本比较
scripts/build.mjs  esbuild 构建（main=ESM, preload=CJS, renderer=IIFE）
```

## 核心原则

1. 极简是默认路径最短，不是功能少。
2. 一切皆插件（复用 Harness 的 Cordis 内核），AI 能给自己加功能。
3. AI 走结构化工具，不拼下载链接。
4. 日志是地基：每次启动、每次崩溃都可归因。
5. 用户 API Key 只存本地；统计数据匿名、可关闭。
