# 开发手册（P0–P25）

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
npm run package      # 便携版 → dist/QDOQMC-win32-x64/QDOQMC.exe
```

打包与更新清单：

```bash
npm run package                                  # 生成便携版目录
Compress-Archive -Path dist/QDOQMC-win32-x64 -DestinationPath dist/QDOQMC-0.1.0-win32-x64.zip
node scripts/make-feed.mjs                       # 生成 dist/latest.json（version/sha256/size）
```

CLI 模式（无窗口，用于自动化验证与排障）：

```bash
# 安装某个版本（幂等：已下载的文件按 sha1 校验后跳过）
node_modules/.bin/electron . --install=1.21.11

# 启动并观察指定秒数，输出进程状态、日志标记、退出码，然后结束游戏
node_modules/.bin/electron . --launch=default --wait=50000

# 更新检查 / 冲突 / 诊断 / 插件 / 工具 / 对话
electron . --chat=/update
electron . --analyze
electron . --diag
electron . --plugins
electron . --enable-plugin=hello-world
electron . --tools
electron . --chat="帮我检查下冲突"
electron . --update-download
electron . --update-apply
electron . --instances
electron . --create-instance="资源包测试"
electron . --activate-instance=default
electron . --content=low-on-fire
electron . --market
electron . --market-install=hello-world
electron . --inspect-modpack=fabulously-optimized
electron . --neoforge=1.21.11
electron . --modpack="D:\packs\test.mrpack"
```

> electron 二进制若未随 npm install 下载成功，可用本地缓存解压：
> 把 `%LOCALAPPDATA%\electron\Cache\*\electron-v43.3.0-win32-x64.zip` 解到
> `node_modules/electron/dist/`，并写入 `node_modules/electron/path.txt` 内容为 `electron.exe`。

## 3. 架构

主进程 = **Cordis 容器**（`@deepseek-ai/cordis`，与 Harness 同一内核）+ 24 个启动器插件。

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
| 11 | llm | `llm` | OpenAI 兼容模型接入（Key 只存本地，可用环境变量覆盖做测试） |
| 12 | mojang | `mojang` | 版本清单 / 版本 JSON / 原版安装（client+libraries+assets+logging） |
| 13 | java | `java` | Java 探测 / 按 major 匹配 / 下载 Mojang 运行时 |
| 14 | instances | `instances` | 实例 / 版本隔离目录 / 绑定版本 |
| 15 | loaders | `loaders` | 加载器安装（Fabric meta 合并） |
| 16 | content | `content` | Modrinth 搜索 / 版本匹配 / 依赖 / 安装 / 启停删 |
| 17 | conflict | `conflict` | 静态冲突分析（重复 id / 缺前置 / 加载器 / breaks） |
| 18 | diagnose | `diagnose` | 崩溃归因（crash-report / latest.log 签名匹配） |
| 19 | launch | `launch` | 版本合并 / natives / classpath / 参数展开 / 进程与退出归因 |
| 20 | tools | `tools` | 启动器能力 → 模型可调用工具（含审计与事件埋点） |
| 21 | agent | `agent` | Agent 循环（模型 ↔ 工具，最多 6 轮） |
| 22 | chat | `chat` | 对话入口：自然语言走 agent，`/命令` 走本地 |
| 23 | plugin-host | `pluginHost` | 第三方插件加载/卸载、权限授权、工具与命令注册 |
| 24 | ipc | — | IPC 通道注册 + 进度与游戏状态推送 |

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

instances/<id>/instance.json      ← 多实例：每实例独立元数据（id/name/versionId/loader/memory）
instances/<id>/.minecraft/        ← 游戏进程 cwd（版本隔离）
  mods/ resourcepacks/ shaderpacks/ saves/ config/ logs/ crash-reports/ screenshots/
```
`<id>` 由实例名生成（中文/特殊字符会生成 `inst-xxxx`），默认实例 id 固定为 `default`；
「当前实例」记录在 `settings.json` 的 `activeInstance`，AI 工具与本地命令默认作用于它。

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

## 9. P3 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 模组元数据解析（fabric.mod.json / mods.toml / neoforge.mods.toml） | ✅ 读出 id/version/depends/breaks，并递归解析 `jars[]` 嵌套提供者 |
| 静态冲突：重复 modid / 缺前置 / 加载器不匹配 / breaks 双向 | ✅ 注入坏模组后精确报出 `Broken Test 需要前置「missing-lib >=1.0.0」` |
| 健康实例零误报 | ✅ 2 个模组 → 0 问题（Fabric API 的 40+ 子模块 provides 正确合并） |
| 模组启用/禁用/删除 | ✅ `.jar` ↔ `.jar.disabled`，删除同步维护 content.json |
| 崩溃归因：真实崩溃 | ✅ 缺前置崩溃 → `category=missing-dependency`，定位到 `broken-test 1.0.0 需要 missing-lib` |
| 崩溃归因：签名覆盖 | OOM / 缺前置 / 重复 mod / Mixin 失败 / Java 版本 / 缺类 / GL 驱动 / JVM 访问冲突 |
| 退出后自动诊断进 UI | ✅ 退出卡片显示诊断摘要 + 3 条建议 |
| 20 个插件全部加载 | ✅ `failed: []`，启动 25ms |

## 10. P4 验收（已实测，2026-10-29）

> 说明：本机没有现成的模型 Key（DSH 的凭据是加密存储，不做提取），所以用**本地 mock LLM 服务器**（`scripts/mock-llm.mjs`，OpenAI 兼容）验证完整链路；真实模型只要在设置里填 Key 即可走同一条路径。

| 验收项 | 结果 |
|---|---|
| OpenAI 兼容接入（/chat/completions + tools + tool_choice） | ✅ DeepSeek 默认端点，baseUrl/model 可配，Key 只存本地 |
| 工具注册（13 个启动器能力 → JSON Schema） | ✅ 状态/搜索/安装/列模组/冲突/诊断/读日志/启动/停止/装版本/装 Fabric/改内存 |
| Agent 循环（模型 ↔ 工具，最多 6 轮） | ✅ 一轮工具调用 + 二次总结，144ms 工具耗时 |
| 真实 HTTP 链路（不是进程内 mock） | ✅ 起本地 mock 服务，走真实 fetch / JSON 序列化 / tool_calls 解析 |
| 意图路由 | ✅ 「检查冲突」→ `analyze_conflicts`；「崩了」→ `diagnose_crash`；「优化模组」→ `search_mods` |
| UI 工具轨迹 | ✅ 气泡下方显示 `✓ analyze_conflicts 检查了 2 个模组…` |
| 无 Key 降级 | ✅ 提示去设置配置，同时保留 `/help` 等本地命令 |
| 23 个插件全部加载 | ✅ `failed: []` |

## 11. P5 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 插件目录扫描 + 清单校验（id/apiVersion/main） | ✅ 识别 `samples/plugins/hello-world`，未启用时为 `granted=false loaded=false` |
| 默认不启用、显式授权 | ✅ `--enable-plugin=hello-world` 后 `loaded=true, tools=[plugin_hello], commands=[hello]` |
| 运行时注册 AI 工具 | ✅ `--tools` 从 12 个变 13 个，含 `plugin_hello` |
| 运行时注册聊天命令 | ✅ `--chat=/hello` → 插件返回「第 1 次问候」（存储计数持久化） |
| 卸载时撤回注册 | ✅ `--disable-plugin` 后工具回到 12 个，命令消失 |
| UI 插件面板 | ✅ 显示名称/版本/权限/工具/命令/状态，可启用、禁用、重载 |
| 启动时自动加载已授权插件 | ✅ 内核 boot 后 `pluginHost.init()` 等待加载完成，工具随后即可用 |
| 审计 | ✅ `plugin:load` / `plugin:unload` / `plugin:error` / `tool:call` 进事件流 |
| 24 个插件全部加载 | ✅ `failed: []` |

> 本轮修掉一个真 bug：启动时在 `for (const id of manifests)` 循环里调用 `load()`，而 `load()` 内部会 `scan()` 重建同一个 Map → 迭代器被破坏、CPU 100% 卡死。改为**先快照 id 再加载**。

## 12. P6 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 便携版打包（不依赖 electron-builder / 联网） | ✅ `npm run package` → `dist/QDOQMC-win32-x64/QDOQMC.exe`（Electron 运行时 + `resources/app`，无需 node_modules） |
| 打包产物可运行 | ✅ 打包版 `--smoke`：24 个插件全部加载，UI 正常截图 |
| 打包版 CLI 可用 | ✅ `QDOQMC.exe --chat=/update`、`--tools`、`--analyze` 等 |
| 分发包 | ✅ `dist/QDOQMC-0.1.0-win32-x64.zip`（138MB） |
| 更新清单 | ✅ `scripts/make-feed.mjs` → `dist/latest.json`（version/size/sha256/url/minSupported/rollout） |
| 更新检查走真实 HTTP | ✅ 本地静态服务 + 设置更新源 → 打包版报「发现新版本 0.2.0（当前 0.1.0）」 |
| BOM 兼容 | ✅ 修复设置文件带 UTF-8 BOM 导致 JSON 解析失败、设置回退默认值的 bug |

## 13. P7 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 更新下载（真实 HTTP + 进度事件） | ✅ 打包版 `--update-download` 从本地静态服务拉 138.3MB |
| sha256 强制校验 | ✅ 清单无 sha256 直接拒绝；下载后不一致即删除文件 |
| 暂存与状态恢复 | ✅ `%APPDATA%\QDOQMC\updates\staged.json`，重启后仍识别为「已下载」 |
| 退出后替换 + 自动重启 | ✅ `apply-update.ps1` 等父进程退出 → Expand-Archive → 重新拉起 |
| 端到端升级 | ✅ 0.1.0 → **0.2.0**：`resources/app/package.json` version 变更、marker 文件出现、进程重启 |
| 更新失败可恢复 | ✅ 替换前校验 zip 大小；脚本异常写 `apply.log` |

> 踩到的两个 Windows 真坑：
> 1. `spawn` 的子进程会被 Electron 的 Windows Job 在父进程退出时连带杀掉 → 改用 `explorer.exe` 打开 `.cmd`，把更新脚本放到 explorer 进程树下。
> 2. `detached: true` + 无控制台时 `powershell.exe` 会立即退出（exit 0）→ 放弃 detached，改由 explorer 启动。

## 14. P8 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 多实例创建 | ✅ `--create-instance="资源包测试"` → `instances/inst-xxxx/`，自动建好 mods/saves/resourcepacks 等目录 |
| 实例列表与当前实例 | ✅ `--instances` 返回 active + 全部实例；`settings.activeInstance` 持久化 |
| 实例切换 | ✅ `--activate-instance=default`；UI 下拉框切换后启动/模组/冲突检查都作用到该实例 |
| 实例删除 | ✅ 非默认实例可删（含目录）；默认实例拒绝删除 |
| 工具作用域 | ✅ AI 工具、`/mod` 等命令改为作用于「当前实例」（不再写死 default） |
| 资源包一键安装 | ✅ `--content=low-on-fire` → `instances/<id>/.minecraft/resourcepacks/LowOnFire v26.2§8.zip` |
| 光影一键安装 | ✅ `--content=bsl-shaders` → `instances/<id>/.minecraft/shaderpacks/BSL_v10.1.8.zip` |
| 实例隔离 | ✅ 资源包/光影只落在测试实例，默认实例目录保持干净 |
| UI 内容类型切换 | ✅ 模组对话框新增「模组 / 资源包 / 光影」标签，资源包标签返回 12 条真实 Modrinth 结果 |
| 24 个插件全部加载 | ✅ `failed: []` |

## 15. P9 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| 市场 feed 加载 | ✅ `--market` 从本地静态服务加载，`source=verified` |
| Ed25519 签名校验 | ✅ 篡改 payload 不重签 → 「市场签名校验失败：feed 可能被篡改」 |
| 插件包 sha256 校验 | ✅ 用私钥签了错误 sha256 的 feed → 「插件包 sha256 校验失败，已拒绝安装」 |
| 一键安装到本地插件目录 | ✅ `--market-install=hello-world` → `plugins/hello-world/{plugin.json,index.mjs}` |
| 安装后立即可见 | ✅ 插件宿主列表中出现该插件，可直接启用 |
| UI 市场页 | ✅ 插件面板新增「本地插件 / 插件市场」标签，显示签名状态与一键安装 |
| 25 个插件全部加载 | ✅ `failed: []` |

> 签名方案：feed = `{format, payload(base64 JSON), signature(base64 Ed25519(payload))}`。
> 设置里配置公钥后**强制验签**（失败即拒绝）；未配置 = 开发模式并标注 `unsigned`。
> 生成工具：`scripts/make-market.mjs`（含开发用密钥对生成，生产请用环境变量指定私钥）。

## 16. P10 验收（已实测，2026-10-29）

| 验收项 | 结果 |
|---|---|
| `.mrpack` 索引解析 | ✅ 本地测试包 + 真实包 `fabulously-optimized`（51 个文件 / 44.9MB / mc 26.2 + fabric 0.19.5） |
| 一键安装整合包 | ✅ 新建实例「QDOQMC 测试整合包」，自动装 Fabric 0.20.1 + 绑定 1.21.11 |
| 模组文件落盘 | ✅ `mods/fabric-api…jar`、`mods/sodium-…jar`，sha1 校验通过（命中缓存） |
| `overrides/` 覆盖 | ✅ `config/qdoqmc-test.txt` 写入实例；`client-overrides/` 同支持，`server-overrides/` 跳过 |
| 安装清单 | ✅ `content.json` 记录 2 个文件（kind=mod） |
| 不支持的加载器 | ✅ 检测到 neoforge/forge 依赖时直接返回明确错误，不会装一半 |
| UI 整合包标签 | ✅ 模组面板新增「整合包」分类，返回 12 条真实 Modrinth 整合包，一键安装 |
| 25 个插件全部加载 | ✅ `failed: []` |

## 17. P11 验收（已实测，2026-10-29）：NeoForge

| 验收项 | 结果 |
|---|---|
| 版本解析 | ✅ maven metadata → `21.11.48`（1.21.11 最新稳定版） |
| 安装器调用 | ✅ 官方 installer `--installClient`，日志 `Successfully installed client into launcher` |
| 安装产物 | ✅ `versions/neoforge-21.11.48/`（26 个运行时库）+ `minecraft-client-patched-21.11.48.jar`（33MB） |
| processor 链（自研执行器） | ✅ 2 个 processor 16 秒跑完（保留给 Forge 复用，见 `lib/forge-installer.ts`） |
| 启动 | ✅ 窗口标题 `Minecraft NeoForge* 1.21.11`；日志含 `Setting user` / `OpenAL` / `Sound engine started` / `Backend library` / `Created: 1024x` / `NeoForge 21.11.48` |
| Fabric 回归 | ✅ 默认实例启动标记全部命中 |
| UI | ✅ 主界面新增「装 NeoForge」按钮 |
| CLI / AI 工具 | ✅ `--neoforge=<mcVersion>`、`install_neoforge` 工具 |

> **根因复盘**：NeoForge 启动失败的真实原因是版本 json 解析把 game args 做成了「二选一」——
> NeoForge 只声明自己的 `--fml.*` 参数，一旦取它就会丢掉原版的 `--username/--accessToken/--version`，
> FML 的 JOptSimple 直接报 `MissingRequiredOptionsException [accessToken, version]` 并弹窗退出。
> 修复：game args 与 libraries/jvm args 一样按继承链**合并**（`chain.flatMap`）。
>
> 另一处坑：FML 要求 `-DlibraryDirectory` 与 patched client jar 就位；用官方安装器注入 profile 后 FML 正确进入
> `CLIENT in PROD` 模式（自研 processor 路径会停在 DEV 模式，因此 NeoForge 安装改走官方 installer）。

## 18. P12 验收（已实测，2026-10-29）：AI 流式输出 + 会话记忆

| 验收项 | 结果 |
|---|---|
| 流式输出 | ✅ CLI `CHAT_STREAM {"deltas":15,"streamedLength":113}`，逐段回调而非一次性返回 |
| 工具调用 + 流式 | ✅ 首轮 tool_calls 分片聚合，第二轮文本流式返回 |
| 会话记忆 | ✅ 同一实例两轮对话，mock 日志 `msgs=4` → `msgs=6`（历史被带入） |
| 记忆持久化 | ✅ `%APPDATA%\QDOQMC\chat-history.json`，重启后 UI 自动恢复历史消息 |
| 清空对话 | ✅ 聊天头部「清空」按钮 + `/clear` 命令 |
| 降级 | ✅ 服务端不支持 SSE 时自动退回一次性响应 |
| mock LLM | ✅ `scripts/mock-llm.mjs` 支持 `stream:true` 的 SSE 分片 |
| 打包版 | ✅ `--smoke` 通过，AI 气泡含工具调用轨迹 |

> 实现：`llm.chatStream` 解析 SSE（content 增量 + tool_calls 分片聚合）→ `agent.run` 透传 `onDelta` →
> chat 插件 `setStreamSink` → IPC `chat:delta` 事件 → 渲染层流式气泡；记忆存 `chat-history.json`（最多 20 条）。

## 19. P13 验收（已实测，2026-10-29）：崩溃一键修复

| 验收项 | 结果 |
|---|---|
| 缺前置归因 → 修复动作 | ✅ `install:missing-lib`（「安装缺失前置」按钮） |
| 一键禁用可疑模组 | ✅ `FIX_RESULT ok`，`sodium-...jar` → `sodium-...jar.disabled` |
| 内存不足 → 调内存 | ✅ OOM 日志 → 建议 6144 MB；执行 `memory:8192` → `instance.json memoryMb=8192` |
| 清理崩溃报告 | ✅ `clear-crash` 动作（有 crash-reports 时出现） |
| 退出卡片 UI | ✅ 真实崩溃（坏模组 HARD_DEP）→ 退出卡片显示诊断 + 「一键修复：安装缺失前置」按钮 |
| 修复后自动刷新 | ✅ 应用修复后重新诊断并刷新修复列表 |
| CLI / AI 工具 | ✅ `--fixes`、`--apply-fix=<id>`、`auto_fix_crash` |
| `--smoke-crash` 自动化 | ✅ 启动 → 崩溃 → 关窗口 → 退出卡片 → 修复按钮，全程 20s 截图留证 |

> 注：Fabric 依赖解析失败时会弹「崩溃窗口」并**保持进程存活**，所以自动化测试里先结束进程再验证退出卡片；
> 真实用户在关掉该窗口后同样会看到这张卡片。

## 20. P14 验收（已实测，2026-10-29）：Forge 1.20.1

| 验收项 | 结果 |
|---|---|
| 版本解析 | ✅ `promotions_slim.json` → `1.20.1-recommended = 47.4.28` |
| 安装器 | ✅ 官方 installer `--installClient`，失败自动重试 3 次（网络抖动时第二次补齐 31 个库） |
| 原版依赖 | ✅ 自动安装 1.20.1（101 秒）并按 `javaVersion` 自动下载 Java 17 运行时（`java-runtime-gamma` 17.0.15） |
| 安装产物 | ✅ `versions/1.20.1-forge-47.4.28/` + `forge-1.20.1-47.4.28-client.jar`（patched client） |
| **启动** | ✅ 窗口标题 `Minecraft* Forge 1.20.1`；日志 `Setting user` / `Backend library: LWJGL 3.3.1` / `OpenAL initialized` / `Sound engine started` |
| BootstrapLauncher 兼容 | ✅ 修复：bootstrap 类加载器（Forge/NeoForge）不再把原版 jar 放进 classpath，改由 `-DlibraryDirectory` 加载 patched jar |
| NeoForge 回归 | ✅ 同样 7 项启动标记全中（去掉原版 jar 后仍正常） |
| UI / AI / CLI | ✅ 主界面「装 Forge」按钮、`install_forge` 工具、`--forge=<mcVersion>` |

> **关键坑**：Forge 1.20.1 报 `ResolutionException: Module minecraft contains package net.minecraft.server, module _1._20._1 exports …`。
> 原因是我们把原版客户端 jar 放进了 classpath，JDK 把它当成自动模块 `_1._20_1`，与 Forge 的 `minecraft` 模块抢包。
> 修复：`mainClass` 命中 `bootstraplauncher` / `fml.startup` 时不加原版 jar。

## 21. P15 验收（已实测，2026-10-29）：插件沙箱（utilityProcess）

| 验收项 | 结果 |
|---|---|
| 插件在独立进程运行 | ✅ 日志 `插件沙箱进程已启动 { id, pid }`；`--plugins` 返回 `sandbox: true, workerPid: 13024` |
| 工具经 RPC 执行 | ✅ `TOOL_RESULT {"ok":true,"summary":"你好，世界！…"}` |
| 命令经 RPC 执行 | ✅ `/hello` 返回「第 2 次问候」，插件存储跨进程/跨启动持久化 |
| 崩溃隔离 | ✅ 测试插件 `process.exit(3)` → `/boom` 返回「插件进程已退出（code 3），已隔离」，宿主继续工作 |
| 退出不误报 | ✅ `before-quit` 标记 disposing，正常退出不再记为崩溃 |
| UI | ✅ 插件卡片显示「沙箱 · PID」标记；提示文案改为「独立 utilityProcess 沙箱」 |
| 构建产物 | ✅ `out/plugin-worker.mjs`（沙箱 worker 独立 bundle） |

> 边界说明：这是**进程隔离 + 受限桥接**（插件拿不到宿主对象，只能 log/storage/callTool/register*）。
> 插件进程内仍有 Node 能力（`require("fs")` 等），真正的 capability 沙箱需要 Node permission model 或 vm 级方案，列为后续。
> 权限模型仍是「显式启用 + 声明式提示」，加载时会把 manifest 的 permissions 写入 permissions.json。

## 22. P16 验收（已实测，2026-10-29）：整合包补全（NeoForge / Forge）

| 验收项 | 结果 |
|---|---|
| NeoForge 整合包 | ✅ `.mrpack` deps `{minecraft:1.21.11, neoforge:21.11.48}` → 新实例 `loader=neoforge, versionId=neoforge-21.11.48`，overrides 落盘 |
| Forge 整合包 | ✅ deps `{minecraft:1.20.1, forge:47.4.28}` → `loader=forge, versionId=1.20.1-forge-47.4.28` |
| **整合包启动** | ✅ 两个包生成的实例都能启动（7 项启动标记全中；Forge 用 Java 17 运行时） |
| Fabric 回归 | ✅ `fabric-loader` 依赖仍走原路径安装 |
| 不支持列表收敛 | ✅ `inspect` 现在只对 quilt 报不支持，NeoForge/Forge 正常返回依赖 |
| 版本覆盖 | ✅ `installForge(mc, versionOverride)` / `installNeoForge(mc, versionOverride)` 按整合包声明的加载器版本安装 |

> 之前 `.mrpack` 遇到 neoforge/forge 依赖会直接报「暂不支持」，现在按依赖类型分派到对应加载器安装器。

## 23. P17 验收（已实测，2026-10-29）：微软正版登录（设备码）

| 验收项 | 结果 |
|---|---|
| 设备码流程 | ✅ `DEVICE_CODE {"userCode":"MOCK-1234","verificationUri":"...","interval":1}` |
| 轮询与完成 | ✅ `LOGIN_STATUS pending` → `ok`，保存官方账号 |
| 账号落盘 | ✅ `account.json`：name/uuid/accessToken/refreshToken/expiresAt |
| 启动使用正版令牌 | ✅ `LAUNCH_START {"playerName":"MockPlayer","accountType":"microsoft"}` |
| 令牌自动续期 | ✅ 把 expiresAt 改成过去 → 启动时日志 `已刷新微软令牌` |
| 退出登录 | ✅ `--logout` → `ACCOUNT_RESULT {"type":"offline",...}` |
| /status | ✅ 显示 `账号：微软正版 · MockPlayer`（离线时显示离线） |
| UI | ✅ 设置里新增「微软账号」区块（登录按钮 + 设备码展示 + 退出）与 client_id 输入 |
| mock 授权服务器 | ✅ `scripts/mock-auth.mjs` 覆盖 devicecode → token → XBL → XSTS → Minecraft → profile 全链路 |

> 真实使用需要用户在 Azure 门户注册一个「公共客户端」应用，把 Application ID 填到设置（或 `QDOQMC_MS_CLIENT_ID`）。
> 我们不做内置 client_id：那属于发行方资质，且需要用户同意服务条款。
> 令牌只存本机 `%APPDATA%\QDOQMC\account.json`，不上传；后续接云服务时再考虑加密存储。

## 24. P18 验收（已实测，2026-10-29）：令牌加密 + 多账号

| 验收项 | 结果 |
|---|---|
| DPAPI 加密落盘 | ✅ `accounts.json` 中 `accessToken: "enc1:djEwEKdu..."`；全文不含明文 `mock-mc-token` |
| 解密后启动 | ✅ 加密账号启动：`LAUNCH_START {"playerName":"MockPlayer","accountType":"microsoft"}` |
| 多账号 | ✅ 两次登录 → `ACCOUNTS_RESULT` 两条（MockPlayer / SecondPlayer，均 `tokenStorage: encrypted`） |
| 切换账号 | ✅ `--switch-account=<uuid>` → 激活 MockPlayer，随后启动 playerName 变为 MockPlayer |
| 移除账号 | ✅ `--remove-account=<uuid>` → 只剩一条，激活项自动回退 |
| 旧版迁移 | ✅ 启动时把 P17 的明文 `account.json` 导入为新格式并清空旧文件 |
| UI | ✅ 设置里账号列表（当前账号高亮 + 「令牌已加密」+ 切换/移除 + 登录添加） |
| 降级 | ✅ safeStorage 不可用时标记 `raw:`（base64），UI 显示「令牌未加密」，不伪装成加密 |

> 加密用 Electron `safeStorage`（Windows 上是 DPAPI，绑定当前 Windows 用户）。换个 Windows 用户/机器就解不开，这是预期行为。
> CLI：`--accounts` / `--switch-account=<uuid>` / `--remove-account=<uuid>`。

## 25. P19 验收（已实测，2026-10-29）：插件能力沙箱（Node permission model）

| 验收项 | 结果 |
|---|---|
| worker 以 Node 身份启动 | ✅ `child_process.fork` + `ELECTRON_RUN_AS_NODE=1` + `--permission` |
| 越权读盘 | ✅ `fs.readFileSync('C:/Windows/win.ini')` → `DENIED:ERR_ACCESS_DENIED` |
| 读自己插件目录 | ✅ `plugin.json` → `READ_OK`（`--allow-fs-read=<插件目录>`） |
| 写盘 | ✅ `fs.writeFileSync(...)` → `DENIED:ERR_ACCESS_DENIED`（未开 allow-fs-write） |
| 起子进程 | ✅ `child_process.execSync` → `DENIED:ERR_ACCESS_DENIED` |
| 正常插件回归 | ✅ hello-world 工具/命令照常工作 |
| 崩溃隔离 | ✅ `process.exit(3)` → 「插件进程已退出（code 3），已隔离」，宿主存活 |
| 打包版 | ✅ 打包后 `--call-tool=plugin_hello` 通过（fork 子进程 PID 22228） |

> 机制：插件 worker 现在由 `child_process.fork` 启动，参数带
> `--permission --allow-fs-read=<插件目录> --allow-fs-read=<worker 目录>`；
> 读插件自身文件可以，越权读/写盘、child_process、worker_threads 全部被 Node 拒绝。
>
> 仍未覆盖：**网络**。Node permission model 目前不限制 net，插件联网能力仍靠 manifest 的 `net` 权限声明与来源审核。
> 另外打包时若以后关闭 RunAsNode fuse，需要回退到 utilityProcess 模式。
>
> 实测命令：`electron . --call-tool=sneak_probe`（临时探测插件），结果：
> `{"outside":"DENIED:ERR_ACCESS_DENIED","own":"READ_OK","write":"DENIED:ERR_ACCESS_DENIED","child":"DENIED:ERR_ACCESS_DENIED"}`

## 26. P20 验收（已实测，2026-10-29）：CurseForge .zip 整合包

| 验收项 | 结果 |
|---|---|
| manifest 解析 | ✅ `CURSE_INSPECT_RESULT {"name":"CF 测试包","mcVersion":"1.20.1","loader":"forge","loaderVersion":"47.4.28","fileCount":1,"bundledMods":0,"needsApiKey":true}` |
| 无 Key + 无内置 mods | ✅ 明确报错：「这个整合包只带文件清单（没有内置 mods），需要配置 CurseForge API Key 才能下载」 |
| 有 Key：解析 fileID → 下载 | ✅ mock API 返回文件名/下载地址 → 下载到实例 `mods/cf-test-mod.jar`（`resolved:1`） |
| 自带 mods 的离线包 | ✅ 无需 Key，`bundled:1` 直接复制进实例 |
| overrides 覆盖 | ✅ `overrides/config/cf-marker.txt` 写入实例 |
| content.json | ✅ 记录 `{"projectId":"curse:111","versionId":"222","fileName":"cf-test-mod.jar"}` |
| 加载器安装 | ✅ 复用 `installForge/installNeoForge/installFabric`（按 manifest 的 `forge-47.4.28` 精确版本） |
| CLI / AI / 设置 | ✅ `--curse-pack=<zip>`、`--inspect-curse-pack=<zip>`、工具 `install_curse_pack`、设置项 `curseforgeApiKey` |
| mock CF API | ✅ `scripts/mock-cf.mjs`（fileID 解析 + CDN 下载） |

> 真实使用需要用户在 CurseForge 申请免费 API Key（填设置即可）；包内自带 `mods/` 的离线包不需要 Key。
> 与 Modrinth 的 `.mrpack` 共用同一套「新建实例 → 装加载器 → 落盘 → overrides」流程。

## 27. P21 验收（已实测，2026-10-29）：整合包 UI（本机文件 + 预览 + 安装）

| 验收项 | 结果 |
|---|---|
| 统一识别 | ✅ `content.inspectPack` 自动区分 `.mrpack`（modrinth.index.json）与 CurseForge `.zip`（manifest.json） |
| 预览卡片 | ✅ 截图显示「Smoke CF 包 · CurseForge · 1.20.1 · forge 47.4.28 · 清单 0 个文件 · 自带 1 个」 |
| UI 安装 | ✅ 点「安装」后新实例 `loader=forge, versionId=1.20.1-forge-47.4.28`，toast「已安装…」 |
| 需要 Key 的包 | ✅ 预览卡片显示「需要 CurseForge API Key」警示 |
| 自动识别安装 | ✅ `content.installPack` 按格式分派到 `installCursePack` / `installModpack` |
| 无文件选择器依赖 | ✅ 支持直接粘贴路径（也为自动化测试留了入口） |
| 回归 | ✅ 原有 Modrinth 整合包搜索/安装、冲突检查、模组面板均正常 |

> 入口：模组面板 → 整合包 → 顶部路径输入框 + 预览/安装；CLI 仍有 `--curse-pack` / `--modpack`。
> smoke 现在会真装一个自带 mods 的 CurseForge 包并等待加载器就绪（`pack.done.loader=forge`）。

## 28. P22 验收（已实测，2026-10-29）：游戏日志查看

| 验收项 | 结果 |
|---|---|
| 日志抽屉双标签 | ✅ 「启动器日志 / 游戏日志」切换 |
| 读取游戏日志 | ✅ `latest.log`（无则最新 `game-*.log`），尾部最多 256KB / 400 行 |
| 自动刷新 | ✅ 游戏日志 tab 每 2 秒刷新（游戏运行时实时可看） |
| 级别高亮 | ✅ ERROR/WARN 行红色/黄色高亮（截图可见 RuntimeException 行标红） |
| 实例参数 | ✅ 按当前实例读取（抽屉标题旁显示 `实例 default`） |
| UI 证据 | ✅ smoke 截图 `smoke-gamelog.png`：7 行日志、1 行 error 高亮 |
| CLI | ✅ `--game-log[=instanceId]` 输出 `GAME_LOG_RESULT`（行数与尾部 5 行） |

> 之前的日志抽屉只有启动器的结构化 JSONL；现在玩家/客服排查时可以直接在应用里看到游戏自己的 latest.log，
> 不用去翻 `%APPDATA%\QDOQMC\instances\<id>\.minecraft\logs`。

## 29. P23 验收（已实测，2026-10-29）：实例导出 / 导入

| 验收项 | 结果 |
|---|---|
| 导出 | ✅ `EXPORT_RESULT {"ok":true,"files":54,"bytes":32889896}`；包内 `mods/*.jar`、`config/*`、`instance.json`，跳过 logs/crash-reports/.cache |
| 导入 | ✅ `IMPORT_RESULT` 返回新实例，`versionId/loader/memoryMb/playerName` 全部还原 |
| 导入实例可启动 | ✅ 启动导入的实例：7 项启动标记全中（fabric 1.21.11），mods 里两个 jar 都在 |
| UI 导出 | ✅ 主页实例行「导出」按钮 → toast「已导出到 …\exports\default-….zip（54 个文件，32119 KB）」 |
| UI 导入 | ✅ 「+ 新建」对话框新增「或从导出包导入」路径输入 + 导入按钮 |
| 安全 | ✅ 解压时拒绝 `..` 路径穿越；只写实例 gameDir |
| CLI / AI | ✅ `--export-instance=<id> [--export-to=<zip>]`、`--import-instance=<zip>`、工具 `export_instance` / `import_instance` |

> 导出名默认 `<data>/exports/<id>-<ts>.zip`；导入默认名 `原实例名（导入）`，避免重名混淆。
> 导出体积只包含实例私有文件（mods/config/存档），不含全局 libraries/assets（那些由启动器按版本重新装）。

## 30. P24 验收（已实测，2026-10-29）：系统文件选择器

| 验收项 | 结果 |
|---|---|
| 整合包选文件 | ✅ 模组面板 → 整合包 → 「选择文件…」→ 输入框自动填入路径（smoke 读到 `pickedPath`） |
| 导入实例选文件 | ✅ 新建实例对话框 → 「选择…」→ 导入路径自动填入（`importPicker.picked`） |
| 导出另存为 | ✅ 「导出」改走保存对话框；smoke 指定路径后 `EXPORT_RESULT` 落到 `out/smoke-export.zip`（32.9MB） |
| 对话框过滤 | ✅ 整合包过滤 `zip/mrpack`；导出包过滤 `zip` |
| 自动化钩子 | ✅ `QDOQMC_PICK_FILE` / `QDOQMC_SAVE_FILE` 环境变量可跳过原生对话框（仅测试用） |
| 回归 | ✅ 整合包预览/安装、实例导入、日志抽屉、冲突检查全部正常（smoke 35.5s / 打包版通过） |

> 原生对话框无法在自动化里点击，所以 IPC 层保留了环境变量旁路；正式运行时两个环境变量都不设置，走真正的 `dialog.showOpenDialog/showSaveDialog`。

## 31. P25 验收（已实测，2026-10-29）：多实例独立账号

| 验收项 | 结果 |
|---|---|
| 实例绑定账号 | ✅ `BIND_RESULT {"instanceId":"default","accountId":"f9dca6df…","accountName":"MockPlayer"}` |
| 启动按实例账号 | ✅ 全局当前账号是 SecondPlayer 时，绑定 MockPlayer 的实例启动 `playerName=MockPlayer` |
| 解绑回全局 | ✅ `--unbind-account` 后同一实例启动 `playerName=SecondPlayer` |
| 列表展示 | ✅ `--instances` 返回 `accountId/accountName`；主页 chip 显示绑定账号名 |
| 多实例并存 | ✅ 实例 `b` 绑定 SecondPlayer，default 绑定 MockPlayer，互不影响 |
| 令牌有效 | ✅ `ensureAccountById` 解密 + 按需刷新（复用 P18 的 DPAPI 加密令牌） |
| CLI / AI | ✅ `--bind-account=<uuid> [--bind-instance=<id>]`、`--unbind-account`、工具 `bind_instance_account` |

> 设计：实例的 `accountId` 为空时跟随「全局当前账号」（auth.accounts 的 active），
> 非空时用该账号的加密令牌启动；`accountName` 是展示用快照，账号被删就回退全局。

## 32. 已知限制 / 待办

- **更新**：只支持便携版（解压替换）；NSIS 安装包升级未做。
- **签名**：便携版未做代码签名，Windows SmartScreen 会提示未知发布者。
- **插件安全**：fork 子进程 + Node permission model（P19）：fs 读白名单到插件目录、禁止写盘/child_process；**网络仍开放**，依赖 manifest 的 net 声明与审核。
- **插件市场**：feed 与签名链路已通；缺少审核、版本更新检测、分类与评分。
- **慢网**：本机到 Mojang 单连接仅 ~50KB/s，并发 16 约 200KB/s，432MB 资源耗时 18 分钟。镜像回退待接入。
- **加载器**：Fabric、NeoForge（1.20.2+）、Forge（1.20.1 实测）已通并可启动；更老的 Forge（1.12.2 等）未验证，Quilt 未做。Forge/NeoForge 安装需 launcher_profiles.json（缺失时自动创建）。
- **整合包**：`.mrpack` 与 CurseForge `.zip` 均支持（Fabric / NeoForge / Forge / 原版）；Quilt 明确报错；CF 需自备 API Key（离线包免 Key）。
- **AI**：真实模型调用需用户自填 Key（本机验证用 mock LLM）；已支持流式输出、会话记忆与崩溃一键修复；多会话/跨实例记忆未做。
- **老版本**：legacy/pre-1.6 资源物化已实现但未实测；Java 8 运行时自动下载未实测。
- **实例**：支持创建/切换/删除/导出/导入/独立账号绑定；实例图标、跨设备同步未做。
- **登录**：微软正版登录已通（设备码 + Xbox Live + Minecraft Services，mock 全链路验证）；需要用户自备 Azure client_id；令牌用 DPAPI 加密存本机，支持多账号切换。

## 33. 后续方向（P26 之后）

P0–P25 的交付已经收口，下面是仍值得做、但优先级低于「能玩、能装、能修」的事项：

1. **代码签名 + NSIS 安装包**：需要代码签名证书（当前只能发便携版 zip）。
2. **更老的 Forge（1.12.2 等）**：需要 Java 8 运行时与旧版 installer 兼容验证。
3. **插件网络白名单**：Node permission model 不管网络，需要 vm/代理层限制 outbound。
4. **实例账号 UI**：目前绑定账号只能走 CLI / AI，界面只能展示 chip。
5. **多会话 AI 记忆、CurseForge 文件选择器集成、实例云同步**。

## 34. 测试用 mock LLM

```bash
node scripts/mock-llm.mjs          # 监听 127.0.0.1:18080

# 另开一个终端：
$env:QDOQMC_LLM_BASE_URL='http://127.0.0.1:18080/v1'
$env:QDOQMC_LLM_KEY='test-key'
$env:QDOQMC_LLM_MODEL='mock-model'
node_modules/.bin/electron . --chat="帮我检查下这个实例有没有冲突"
```

会打印 `CHAT_RESULT`（含 text 与 trace）。`npm run smoke` 在同样的环境变量下会截图 `out/smoke-ai.png` 并输出 `ai.trace`。

## 35. 总验收矩阵（P0–P25，全部真机运行 / 截图 / 日志取证）

| 阶段 | 交付 | 关键证据 |
|---|---|---|
| P0 | 骨架 / 插件内核 / 极简 UI / 日志 / 设置 / 抽象服务 / 更新检查 / 埋点 | 6 张截图，内核 0 失败 |
| P1 | 原版安装 + Java 匹配 + 一键启动 | 1.21.11 进主菜单，7 项启动标记 |
| P2 | Fabric + Modrinth 模组一键安装 | Fabric 0.20.1；sodium 落盘并启动 |
| P3 | 冲突静态分析 / 崩溃归因 / 模组启停 | 坏模组精确报「缺 missing-lib」 |
| P4 | AI 工具调用（自然语言驱动） | mock LLM 跑通「模型→工具→回答」 |
| P5 | 插件宿主（注册 AI 工具/命令） | 示例插件 `/hello` + `plugin_hello` |
| P6 | 便携版打包 + 更新清单 | 138MB zip + latest.json（sha256） |
| P7 | 自动更新下载 / 退出替换 / 重启 | 0.1.0 → 0.2.0 真机实升 |
| P8 | 多实例 + 资源包 / 光影 | 测试实例装资源包/光影，默认实例零污染 |
| P9 | 插件市场（Ed25519 签名） | 篡改 feed / sha256 均被拒 |
| P10 | .mrpack 整合包安装 | 本地包 + Fabulously Optimized 索引解析 |
| P11 | NeoForge 安装 + 启动 | 窗口 `Minecraft NeoForge* 1.21.11` |
| P12 | AI 流式输出 + 会话记忆 | 15 个增量片段；msgs 4→6 证明历史注入 |
| P13 | 崩溃一键修复 | 真实坏模组崩溃 → 退出卡片 → 修复按钮 |
| P14 | Forge 1.20.1 安装 + 启动 | 窗口 `Minecraft* Forge 1.20.1`；Java 17 自动下载 |
| P15 | 插件沙箱（utilityProcess） | 插件 process.exit(3) 被隔离，宿主存活 |
| P16 | 整合包补全（NeoForge/Forge 依赖） | 两种依赖包都能生成可启动实例 |
| P17 | 微软登录（设备码全链路） | mock 授权服务器 → MockPlayer 账号落盘 |
| P18 | 令牌 DPAPI 加密 + 多账号 | accounts.json 无明文；切换/移除生效 |
| P19 | 插件能力沙箱（Node permission model） | 越权读/写/子进程全部 ERR_ACCESS_DENIED |
| P20 | CurseForge `.zip` 整合包 | mock CF API 解析 → 下载 → 落盘 |
| P21 | 整合包 UI（预览 + 安装） | UI 预览卡片 + toast，实例 loader=fabric |
| P22 | 游戏日志查看 | 日志抽屉双标签，ERROR 高亮，7 行实测 |
| P23 | 实例导出 / 导入 | 导出 54 文件；导入实例启动 7 项标记 |
| P24 | 系统文件选择器 | 导出另存 32.9MB；选择文件自动填路径 |
| P25 | 多实例独立账号 | 全局 SecondPlayer 时，绑定实例用 MockPlayer 启动 |
| P26 | 版本管理 + 中文语言 + 设置说明 + MC/大肥鱼主题 | 版本表 4 个文件夹按钮；`options.txt` 由 `en_us` 改 `zh_cn` |
| P27 | PCL 式常驻左侧版本列表 | 侧栏卡片 2 张、点卡片切实例 `sidebar.active=默认实例` |
| P28 | 下载清晰化：加载器可用性 + PCL 式进度 + 镜像/分片加速 | 1.20.1 → Fabric 20 个版本可选 / Forge 20 个 / NeoForge 不支持；下载中 6%、451 KB/s、剩余 4 分 29 秒、文件 14/76、取消后「已取消」；真机 auto 选源 official 510 KB/s vs bmclapi 154 KB/s → 选 official；分片 x4 实测 4 次 206 + sha1 正确 |
| P28 | ComfyUI 美术接入 | 本机 SD1.5 出图 4 张（吉祥物/草地砖/背景/图标），构建自动拷入 `out/renderer/assets`，缺图回退 SVG |
| P29 | PCL 式下载中心 + 主界面重组 | 左侧分类 6 项；主界面只剩版本卡片/启动/4 个快捷入口；smoke 实测 mods 20 条、资源包 20、光影 20、整合包 20 |
| P29 | 逐文件下载进度（含整合包） | 任务页 75 个文件逐行状态 + 大小，`filesDone` 0→1→2 递增；整合包 100% 完成页 |
| P29 | 资源/光影预览 + 模组更新检查 | Sodium 画廊 6 张图渲染成功；检查更新实测 1 项「0.8.14 → 0.8.15-beta.1」可一键更新 |
| P29 | 用户背景图接入 | `uploads/…png` → `art/bg-user.jpg`（1920×1079, 306KB），构建自动打包 |
| P30 | CurseForge 内容源 + Key 测试 | 真机真 Key：搜索 20 条真实结果（GeckoLib / JEI / Cloth Config…）带 CurseForge 徽章；`testCurseForge` = 基础 OK / 详情 OK / 搜索 OK（884–1208ms）；`source:'all'` 合并两源；mock 下 `install cf-111` 落盘 `cf-fake-mod.jar` 且 content.json 记录 `source:'curseforge'` |
| P30 | 设置页新增 CurseForge Key + 测试按钮 | 输入框（密码型）+ 三项分报结果；无 Key / 403 时给中文提示，不影响 Modrinth |
| P30 | 实例删除 + 游戏版本卸载 | smoke 实测：版本管理点「删除」删掉「Smoke Fabric 包」实例（count 3→2，toast 已删除）；新增 `versions.remove` 卸载版本文件并解绑实例、释放磁盘 |
| P31 | 主界面重构：左侧栏=版本列表+版本卡+启动，中间留空，两侧可收起 | 顶栏去掉「模组/版本」；中间只剩更新横幅/退出诊断；左右侧栏都可收起；smoke 87s 通过 |
| P31 | 设置：个性化 + 启动选项 + Java + 高性能显卡 + 版本隔离 | 设置页新增 7 组：个性化（标题/主题色/背景图）、启动选项（宽高/全屏/JVM）、Java（列出 4 个/选择/手动添加）、显卡开关（写 UserGpuPreferences）、版本隔离开关；settings smoke 断言 title/accent/gpu/javaRadios 全 true |
| P31 | 下载中心增量显示 | `source:'all'` 先出 Modrinth、CurseForge 到了再补（不再等慢源） |
| P32 | AI 写插件 / 自升级（harness 内核） | 新增 `write_plugin`/`list_plugins`/`remove_plugin` 三个 AI 工具 + `plugin-host.installFromSource/remove`（写 plugin.json+index.mjs → 沙箱加载 → 失败回滚）+ agent 系统提示教模型自我扩展；`--check-p32` 单进程实测：写→列出(2 个)→调 `smoke_ai_tool`(返回「AI 插件工作正常」)→删除，全绿且不烧模型 Key |
| P33 | 补齐 harness 能力 | `read_file`/`write_file`/`list_dir`/`web_fetch`/`restart_self` + `run_command`（只读命令白名单）+ `update_settings`（AI 改自己设置）+ `check_update`/`apply_update`（AI 下载启动器更新）+ `delegate`/`delegate_many`（子助手，最多 3 并行、1 层）；`--call-tool` 实测 5 项全绿（java_version 返回 OpenJDK 21、list_dir/read_file/update_settings/check_update） |
| P34 | 危险操作确认 + 模型可换 + 工具调用自纠 | 设置 `confirmDangerousOps`（默认开）：AI 要对 `stop_game/remove_plugin/write_file/apply_update/restart_self…` 动手前先说明、等用户回「确认」；模型只回文字不调工具时自动追加一次纠正提示再试；设置页加「快速切换模型」（deepseek-chat / deepseek-reasoner / 自定义） |

> 汇总口径：每阶段都跑过 `npm run smoke` 与打包版 `--smoke`；涉及游戏启动的阶段有真实窗口标题与启动标记日志。
> P28 另附 `scripts/p28-check.mjs`（下载器/镜像/分片实测，不启动 UI）和 [docs/P28-NOTES.md](P28-NOTES.md)（实现与实测数据）。
> P29 另附 `scripts/p29-check.mjs`、[docs/P29-NOTES.md](P29-NOTES.md) 和 [docs/P29-SPEC.md](P29-SPEC.md)（接口契约）。
> P31 另附 `scripts/p31-check.mjs` 和 [docs/P31-NOTES.md](P31-NOTES.md)（GPU 注册表 / Java / junction 实测）。
