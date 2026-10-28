# 开发手册（P0）

## 1. 环境

| 项 | 要求 |
|---|---|
| Node | 22+（当前实测 24.18.1） |
| 系统 | Windows 10/11 |
| Electron | 43.3.0（已锁版本） |
| 包管理 | npm（registry 用 npmmirror 时最快） |

## 2. 命令

```bash
npm install          # 首次
npm run build        # esbuild → out/{main,preload,renderer}
npm start            # 启动 Electron
npm run smoke        # 冒烟：截图 + 点击「启动游戏」+ 调一次 IPC，输出 SMOKE_RESULT JSON
npm run typecheck    # tsc --noEmit
```

> electron 二进制若未随 npm install 下载成功，可用本地缓存解压：
> 把 `%LOCALAPPDATA%\electron\Cache\*\electron-v43.3.0-win32-x64.zip` 解到
> `node_modules/electron/dist/`，并写入 `node_modules/electron/path.txt` 内容为 `electron.exe`。

## 3. 架构

主进程 = **Cordis 容器**（`@deepseek-ai/cordis`，与 Harness 同一内核）+ 13 个启动器插件。

插件按固定顺序装配（`src/main/kernel.ts`），每个插件通过 `ctx.provide(name, value)` 暴露服务，
后续插件用 `use<T>(ctx, name)` 取用。任何一个插件加载失败都不会阻塞其它插件，
失败清单会通过 `AppInfo.failedPlugins` 暴露到界面与日志。

| # | 插件 | 服务 | 职责 |
|---|---|---|---|
| 1 | app | `appMeta` | 版本 / 运行时 / 启动模式 |
| 2 | paths | `paths` | 数据目录布局（data/logs/cache/instances/downloads） |
| 3 | logger | `log` | 结构化 JSONL 日志 + 内存环形缓冲 |
| 4 | settings | `settings` | 设置持久化（原子写） |
| 5 | storage | `storage` | 存储抽象（云存档地基，标注可同步目录） |
| 6 | identity | `identity` | 匿名 install_id（统一身份地基） |
| 7 | entitlement | `entitlement` | 授权门控（免费期全放行） |
| 8 | cloud | `cloud` | CloudPort：联网唯一出口，默认离线实现 |
| 9 | telemetry | `telemetry` | 事件埋点（本地 jsonl，opt-in 上报） |
| 10 | updater | `updater` | 更新检查状态机（下载替换在 P5） |
| 11 | instances | `instances` | 实例 / 版本隔离目录 / 启动预检（干跑） |
| 12 | chat | `chat` | 本地命令路由（P4 升级为 AI 工具调用） |
| 13 | ipc | — | IPC 通道注册 |

渲染进程只通过 `window.qdo`（preload 的 contextBridge）访问主进程，契约见 `src/shared/api.ts`。

## 4. 数据目录

`%APPDATA%\QDOQMC\`

```
settings.json          设置（apiKey 只存本地）
identity.json          匿名设备标识
license.json           （未来）签名许可
events/events.jsonl    事件流（统计与转化分析）
logs/app-YYYY-MM-DD.jsonl  结构化日志
instances/default/     默认实例（版本隔离目录）
  ├─ instance.json
  ├─ mods/ resourcepacks/ shaderpacks/ saves/ config/ logs/ crash-reports/
  └─ version/          （P1）该实例的 version.json
cache/ downloads/ tmp/ （P1 接入的内容寻址缓存）
```

日志每条一行 JSON：`{ ts, level, scope, message, data? }`，可直接 `jq` 或喂给 P3 的崩溃诊断。

## 5. 加一个插件

```ts
// src/main/plugins/hello.ts
import { definePlugin, type LauncherPlugin } from '../plugin-kit'

export interface HelloService { ping(name: string): string }

export function createHelloPlugin(): LauncherPlugin<void> {
  return definePlugin('hello', () => (ctx) => {
    ctx.provide('hello', { ping: (n: string) => `hi ${n}` } satisfies HelloService)
  })
}
```

然后在 `kernel.ts` 的 `plugins` 数组里、以及依赖它的插件之前插入 `createHelloPlugin()`。

## 6. P0 验收（已实测）

| 验收项 | 结果 |
|---|---|
| 13 个插件全部加载、无失败 | ✅ `failed: []`，boot 21ms（内核）/ 2.3s（含窗口） |
| 窗口渲染极简界面（实例条 + 大启动键 + AI 面板 + 状态栏） | ✅ `out/smoke.png` |
| 点击「启动游戏」→ IPC → 实例预检 → 步骤回填 UI | ✅ `out/smoke-launch.png` |
| 聊天 `/status` 走 IPC 返回真实服务数据 | ✅ 返回版本/实例/内存/统计/授权 |
| 未配置更新源 = 离线模式，不联网、不崩 | ✅ 状态栏「离线模式」 |
| 结构化日志与事件落盘 | ✅ `logs/app-*.jsonl`、`events/events.jsonl` |
| 无后端可全功能运行 | ✅ （除更新/上报外） |

## 7. 已知限制

- 启动按钮只做预检（P1 接入真实下载与启动）。
- 实例管理只支持默认实例（P1 扩展多实例）。
- 更新只到「检查」环节（P5 做下载替换）。
- AI 只有本地命令（P4 接入模型与工具调用）。
- 尚未打包（P5 做 electron-builder + 签名）。

## 8. 下一步（P1）

1. Mojang 版本清单 → 版本 JSON → libraries/assets 下载 + sha1 校验 + 断点续传。
2. Java 运行时探测与自动下载匹配。
3. classpath / natives / 参数模板组装，spawn 子进程接管 stdout/stderr（注意 GBK）。
4. 实例多开与全局共享缓存 + 硬链接。
5. 离线登录（正版 OAuth 在 P2）。
