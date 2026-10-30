# 贡献指南 / CONTRIBUTING

感谢你愿意帮方块鱼变得更好。提 Issue、写插件、改代码都欢迎。

## 提 Issue

- 先搜索是否已有相同问题
- Bug 请附上：**版本号**、复现步骤、`日志`（`%APPDATA%\QDOQMC\logs\` 下最新的 `.jsonl`）
- **不要**在 Issue 里贴 API Key、账号密码、完整文件路径中的用户名（请打码）

## 提 PR

1. Fork 后从 `master` 切分支：`fix/xxx` 或 `feat/xxx`
2. 改完必须通过：
   ```bash
   npm install
   npm run typecheck
   npm run build
   ```
3. 提交信息写清楚「改了什么、为什么」，一个 PR 只做一件事
4. 涉及 UI 的 PR 请附截图
5. 不要在 PR 里提交 `out/`、`dist/`、`node_modules/`

## 代码结构

```
src/
  main/            主进程
    plugins/       Cordis 插件（每个能力一个插件）
      agent.ts     AI agent 循环（模型→工具→结果）
      tools.ts     工具注册表（40+ 工具）
      plugin-host.ts 插件沙箱宿主
      content.ts   下载/模组/整合包
      diagnose.ts  崩溃诊断 + 一键修复
    index.ts       入口 / CLI / 冒烟测试
  preload/         contextBridge
  renderer/        React 界面
  shared/          类型、IPC 通道、API 契约
docs/              文档（DEV.md 有完整开发记录）
```

## 插件与文档

想加新能力，优先考虑**写插件**而不是改内核：插件在沙箱里跑，不会因为你的改动让启动器起不来。
详见 [docs/PLUGINS.md](docs/PLUGINS.md)。
