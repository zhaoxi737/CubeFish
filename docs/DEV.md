# 开发手册（P0–P2）

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
npm run smoke        # 冒烟：截图 + 读 UI 状态 + 调一次 IPC，输出 SMOKE_RESULT JSON
npm run typecheck    # tsc --noEmit
```

CLI 模式（无窗口，用于自动化验证与排障）：

```bash
# 安装某个版本（幂等：已下载的文件按 sha1 校验后跳过）
node_modules/.bin/electron . --install=1.21.11

# 启动并观察指定秒数，输出进程状态、日志标记、退出码，然后结束游戏
node_modules/.bin/electron . --launch=default --wait=50000
```

> electron 二进制若未随 npm install 下载成功，可用本地缓存解压：
> 把 `%LOCALAPPDATA%\electron\Cache\*\electron-v43.3.0-win32-x64.zip` 解到
> `node_modules/electron/dist/`，并写入 `node_modules/electron/path.txt` 内容为 `electron.exe`。

## 3. 架构

主进程 = **Cordis 容器**（`@deepseek-ai/cordis`，与 Harness 同一内核）+ 18 个启动器插件。

插件按固定顺序装配（`src/main/kernel.ts`），每个插件通过 `ctx.provide(name, value)` 暴露服务，
后续插件用 `use<T>(ctx, name)` 取用。任何一个插件加载失败都不会阻塞其它插件，
失败清单会通过 `AppInfo.failedPlugins` 暴露到界面与日志。

| # | 插件 | 服务 | 职责 |
|---|---|---|---|
| 1 | app | `appMeta` | 版本 / 运行时 / 启动模式 |
| 2 | paths | `paths` | 数据目录布局（logs/cache/meta/versions/libraries/assets/runtimes） |
| 3 | logger | `log` | 结构化 JSONL 日志 + 内存环形缓冲 |
| 4 | settings | `settings` | 设置持久化（原子写） |
| 5 | storage | `storage` | 存储抽象（云存档地基，标注可同步目录） |
| 6 | identity | `identity` | 匿名 install_id（统一身份地基） |
| 7 | entitlement | `entitlement` | 授权门控（免费期全放行） |
| 8 | cloud | `cloud` | CloudPort：联网唯一出口，默认离线实现 |
| 9 | telemetry | `telemetry` | 事件埋点（本地 jsonl，opt-in 上报） |
| 10 | updater | `updater` | 更新检查状态机（下载替换在 P5） |
| 11 | mojang | `mojang` | 版本清单 / 版本 JSON / 原版安装（client+libraries+assets+logging） |
| 12 | java | `java` | Java 探测 / 按 major 匹配 / 下载 Mojang 运行时 |
| 13 | instances | `instances` | 实例 / 版本隔离目录 / 绑定版本 |
| 14 | loaders | `loaders` | 加载器安装（Fabric meta 合并） |
| 15 | content | `content` | Modrinth 搜索 / 版本匹配 / 依赖 / 安装 |
| 16 | launch | `launch` | 版本合并 / natives / classpath / 参数展开 / 进程与退出归因 |
| 17 | chat | `chat` | 本地命令路由（P4 升级为 AI 工具调用） |
| 18 | ipc | — | IPC 通道注册 + 进度与游戏状态推送 |

渲染进程只通过 `window.qdo`（preload 的 contextBridge）访问主进程，契约见 `src/shared/api.ts`。

## 4. 数据目录

`%APPDATA%\QDOQMC\`

```
settings.json               设置（apiKey 只存本地）
identity.json               匿名设备标识
events/events.jsonl         事件流（统计与转化分析）
logs/app-YYYY-MM-DD.jsonl   结构化日志

meta/                       官方 JSON 缓存（version_manifest_v2.json、versions/<id>.json、java-runtime/）
versions/<id>/<id>.json     版本 JSON 副本
versions/<id>/<id>.jar      客户端 jar（原版）
versions/<id>/natives/      老世代 natives 解压目录
libraries/                  全局共享（Maven 布局）
assets/objects/xx/<sha1>    全局共享资源对象（内容寻址）
assets/indexes/<id>.json    资源索引
assets/virtual/<id>/        旧版资源物化（legacy / pre-1.6）
cache/objects/xx/<sha1>     全局下载缓存（多实例/多版本复用，硬链接落盘）

instances/default/instance.json
instances/default/.minecraft/   ← 游戏进程 cwd（版本隔离）
  mods/ resourcepacks/ shaderpacks/ saves/ config/ logs/ crash-reports/ screenshots/
```

日志每条一行 JSON：`{ ts, level, scope, message, data? }`，可直接 `jq` 或喂给 P3 的崩溃诊断。
游戏 stdout/stderr 原始字节另存 `instances/<id>/.minecraft/logs/game-<ts>.log`（便于换编码重解）。

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
| 16 个插件全部加载、无失败 | ✅ `failed: []`，内核 boot 25ms |
| 极简界面（实例条 + 版本选择 + 大启动键 + AI 面板 + 状态栏） | ✅ `out/smoke.png` |
| 聊天命令走 IPC 返回真实服务数据 | ✅ `/status` 返回版本/实例/内存/统计/授权 |
| 未配置更新源 = 离线模式，不联网、不崩 | ✅ 状态栏「离线模式」 |
| 结构化日志与事件落盘 | ✅ `logs/app-*.jsonl`、`events/events.jsonl` |
| 无后端可全功能运行 | ✅（除更新/上报外） |

## 7. P1 验收（已实测，2026-10-28）

| 验收项 | 结果 |
|---|---|
| 原版安装：client jar + 76 个库 + 4591 个资源对象 + 日志配置 | ✅ 1.21.11，432MB |
| sha1 校验 + 断点续传 + 内容寻址缓存 | ✅ 二次安装 10.8s（全部命中缓存并校验） |
| Java 探测与匹配 | ✅ 探测到 3 个 JDK 21，选 Microsoft OpenJDK 21 |
| 启动参数组装（arguments 新格式、rules、占位符、离线 UUID） | ✅ 76 条 classpath、33 个参数 |
| 进程启动与日志接管 | ✅ 980ms 起进程，stdout 112 行进游戏日志 |
| 游戏真正进入主菜单 | ✅ 窗口 `Minecraft 1.21.11`，1.07GB 内存，OpenAL 初始化，纹理图集全部创建 |
| 正常退出与退出码归因 | ✅ `Stopping!` → 退出码 0，无 crash-report |
| 实例绑定与版本隔离 | ✅ `instances/default/.minecraft`，全局 assets/libraries 复用 |

## 8. P2 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| Fabric 加载器安装（meta API 纯合并，无安装器进程） | ✅ Fabric Loader 0.20.1 for 1.21.11，8 个库 |
| 加载器版本启动（inheritsFrom 合并 + 原版 jar 定位） | ✅ `LAUNCH_START ok`，527ms 起进程 |
| Modrinth 搜索 | ✅ UI 一次返回 12 条真实结果（Fabric API / Sodium / Iris / Entity Culling…） |
| 版本匹配（game_version + loader facet） | ✅ Sodium 正确选到 `mc1.21.11-0.8.14-fabric`（修复前误选 neoforge 版） |
| 一键安装到实例 | ✅ `mods/fabric-api-0.141.6+1.21.11.jar`、`mods/sodium-fabric-0.8.14+mc1.21.11.jar` |
| 安装清单（content.json，回滚/冲突分析用） | ✅ 记录 projectId/versionId/fileName/sha1 |
| 装完后游戏真的加载模组 | ✅ 日志：`Loading Minecraft 1.21.11 with Fabric Loader 0.20.1` / `Loading 49 mods` / `- fabric-api 0.141.6` / `- sodium 0.8.14` |
| Sodium 实际生效 | ✅ `Loaded configuration file for Sodium: 36 options available`，Mixin 子系统加载 |
| 无崩溃 | ✅ 无 crash-report，正常进主菜单（Realms JWT 报错是离线模式预期） |

## 9. 已知限制 / 待办

- **慢网**：本机到 Mojang 单连接仅 ~50KB/s，并发 16 约 200KB/s，432MB 资源耗时 18 分钟。BMCLAPI 镜像是同速，镜像回退待接入（设置里预留了位置）。
- **加载器**：Fabric 已通；NeoForge/Forge（processors 执行引擎）未做，Quilt 不做。
- **内容**：mod/资源包/光影的搜索安装已通；`.mrpack` 整合包、依赖图完整求解（只做了 required 依赖递归）未完成。
- **老版本**：legacy/pre-1.6 资源物化已实现但未实测；Java 8 运行时自动下载未实测。
- **实例**：只有默认实例；多实例创建/切换待补。
- **登录**：仅离线（正版 OAuth 未做）。
- **更新**：只到「检查」环节（P5 做下载替换与签名）。
- **打包**：尚未打包（P5 做 electron-builder + 签名）。

## 10. 下一步（P3：能治 / 能装补全）

1. 静态冲突分析：解析 `fabric.mod.json` 的 depends/breaks、重复 modid、loader 不匹配。
2. 崩溃归因：`crash-reports` / `latest.log` 解析 + 常见崩溃签名库。
3. 模组管理 UI：启用/禁用、卸载、按实例查看。
4. NeoForge/Forge processors 引擎（P2 遗留的最脏一块）。
5. `.mrpack` 整合包一键安装。
