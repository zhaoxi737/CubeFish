# 开发手册（P0–P7）

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

## 14. 已知限制 / 待办

- **更新**：只支持便捷版（解压替换）；NSIS 安装包升级未做。
- **签名**：便携版未做代码签名，Windows SmartScreen 会提示未知发布者。
- **插件安全**：主进程内加载（Node 全权限），权限字段是提示性的；真正沙箱未做。
- **插件市场**：只有本地目录安装，没有远程分发与签名校验。
- **慢网**：本机到 Mojang 单连接仅 ~50KB/s，并发 16 约 200KB/s，432MB 资源耗时 18 分钟。镜像回退待接入。
- **加载器**：Fabric 已通；NeoForge/Forge（processors 执行引擎）未做，Quilt 不做。
- **内容**：mod/资源包/光影的搜索安装已通；`.mrpack` 整包、完整依赖图求解未完成。
- **AI**：真实模型调用需用户自填 Key（本机验证用 mock LLM）；流式输出、会话记忆未做。
- **老版本**：legacy/pre-1.6 资源物化已实现但未实测；Java 8 运行时自动下载未实测。
- **实例**：只有默认实例。
- **登录**：仅离线（正版 OAuth 未做）。

## 15. 下一步（P8：补账与打磨）

1. **NSIS 安装包 + 代码签名**（有证书后）。
2. **插件沙箱化**：utilityProcess + 受限 API + 权限确认弹窗。
3. **插件市场**：静态 feed + 签名校验。
4. **补账**：NeoForge/Forge processors、`.mrpack`、资源包/光影 UI、多实例、正版登录。
5. **体验**：流式 AI 输出、会话记忆、崩溃一键修复动作。

## 16. 测试用 mock LLM

```bash
node scripts/mock-llm.mjs          # 监听 127.0.0.1:18080

# 另开一个终端：
$env:QDOQMC_LLM_BASE_URL='http://127.0.0.1:18080/v1'
$env:QDOQMC_LLM_KEY='test-key'
$env:QDOQMC_LLM_MODEL='mock-model'
node_modules/.bin/electron . --chat="帮我检查下这个实例有没有冲突"
```

会打印 `CHAT_RESULT`（含 text 与 trace）。`npm run smoke` 在同样的环境变量下会截图 `out/smoke-ai.png` 并输出 `ai.trace`。
