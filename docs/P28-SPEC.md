# P28 规格：下载清晰化 + PCL 式进度 + 镜像加速

本文件是 P28 的唯一接口契约。后端按此实现，前端按此调用，避免两侧对不上。

## 0. 用户痛点（必须解决）

1. 不知道「游戏版本 ↔ 模组加载器版本」怎么配，下载区不清晰。
2. 下载过程不透明：看不到总量、速度、剩余时间、正在下哪些文件。
3. 不知道 PCL 为什么快（答案：国内镜像源 + 多线程分片下载 + 资源站 API）。

## 1. 共享类型（src/shared/types.ts）

```ts
/** 下载源：auto = 自动测速选最快，official = Mojang 官方，bmclapi = 国内镜像 */
export type DownloadSource = 'auto' | 'official' | 'bmclapi'

/** 一个下载阶段（PCL 式分阶段进度条） */
export interface StageProgress {
  stage: string            // 'version' | 'libraries' | 'assets' | 'logging' | 'done' | 'content'
  label: string            // 中文短名，如 '下载库文件'
  done: number             // 该阶段已完成文件数
  total: number            // 该阶段文件总数
  bytes: number            // 该阶段已下载字节
  bytesTotal: number       // 该阶段总字节（未知时 0）
  state: 'pending' | 'running' | 'done'
}

/** 进度事件：所有新增字段可选，旧发射方不受影响 */
export interface TaskProgress {
  taskId: string
  kind: 'install' | 'update' | 'content'
  stage: string
  done: number
  total: number
  bytes: number
  message?: string
  // ---- P28 新增 ----
  percent?: number         // 整体加权百分比 0..100
  bytesTotal?: number      // 本次任务总字节
  speed?: number           // 字节/秒（2s 滑动平均）
  etaMs?: number           // 预计剩余毫秒（未知时省略）
  currentFile?: string     // 当前正在下载的文件名/label
  filesDone?: number
  filesTotal?: number
  stages?: StageProgress[] // 阶段快照，按顺序
  source?: DownloadSource  // 实际使用的下载源
}

/** 某个 MC 版本可用的加载器 */
export interface LoaderChoice {
  loader: 'fabric' | 'forge' | 'neoforge'
  versions: string[]       // 可用加载器版本，新→旧，最多 20 个
  recommended?: string     // 推荐版本（Fabric 取最新稳定；Forge 取推荐 build；NeoForge 取最新）
  note?: string            // 例如 '仅支持 1.20.1 及以下' / '查询失败'
}

export interface LoaderAvailability {
  gameVersion: string
  release: boolean
  javaMajor?: number
  loaders: LoaderChoice[]  // 不可用的加载器不出现
}
```

`SearchHit` 追加两个可选字段（Modrinth search 响应里本来就有）：

```ts
gameVersions?: string[]   // 该项目最新版本支持的游戏版本
loaders?: string[]        // 'fabric' | 'forge' | 'neoforge' | 'quilt'
```

## 2. 后端 API

### 2.1 loaders 插件

```ts
ctx.provide('loaders', {
  fabric(gameVersion: string): Promise<FabricInstallResult>,
  neoforge(gameVersion: string, versionOverride?: string): Promise<...>,
  forge(gameVersion: string, versionOverride?: string): Promise<...>,
  /** P28 新增：列出某版本可用的三种加载器及版本清单 */
  available(gameVersion: string): Promise<LoaderAvailability>,
})
```

IPC：`CH.loaderAvailable` → preload `window.qdo.loaders.available(gameVersion)`。

数据来源（都已有现成实现，复用即可）：
- Fabric：`https://meta.fabricmc.net/v2/versions/loader/<mc>`，取 `version` 字段；只保留 `stable: true` 的。
- NeoForge：`https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml`，按 MC 版本过滤（1.21 → 21.1.x，1.20.4 → 20.4.x，1.20.2 → 20.2.x，1.21.1 → 21.1.x），旧版本走 forge 的 `1.20.1` 组合。
- Forge：`https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json`（键 `1.20.1-recommended`），拿不到再查 `maven-metadata.xml`。
- 任一来源失败 → 该 `LoaderChoice.note = '查询失败，可稍后重试'`，`versions: []`，不要抛错。

### 2.2 versions 插件

```ts
ctx.provide('mojang', {
  // 已有：manifest/list/versionJson/install/installed
  /** P28 新增：取消当前安装任务（中止下载，清理 .part） */
  cancel(): Promise<{ ok: boolean; cancelled: boolean }>
})
```

IPC：`CH.versionCancel` → preload `window.qdo.versions.cancel()`。
实现要点：安装任务注册一个 `AbortController`；`install()` 内部所有 Downloader 共享该 signal；用户取消后 progress 事件发 `stage: 'cancelled'`，`message: '已取消'`。旧的 smoke 流程不受影响。

### 2.3 下载器（src/main/lib/downloader.ts）

保留现有「断点续传 + sha1 校验 + 原子落盘 + 内容寻址缓存」，新增：

1. **字节级实时进度**：`onProgress(done, total, bytes, label, stats)`，其中 `bytes` = 已完成文件字节 + 各在途文件已写入字节（实时），`stats.bytesTotal` = 全部 spec 的 size 之和（未知按 0 计）。
2. **速度**：下载器内部维护最近 2s 字节增量算平均速度（`stats.speed`），以及 `etaMs`（`(bytesTotal - bytes) / speed`）。
3. **分片下载（PCL 快的关键）**：文件 `size >= 4MB` 且服务端支持 Range 时，切成 `threads` 段并发拉取后合并；单文件分片数默认 4，全局 socket 并发由 `concurrency`（默认 8）控制，总连接数不超过 `concurrency * 2`。服务端返回 200/416 时自动回退单流。`.part` 文件命名保持 `${dest}.part`（分片先写 `${dest}.part.<i>`，完成后合并为 `.part` 再 rename）。
4. **取消**：`new Downloader({ signal })`，中断时清理临时文件并抛 `AbortError`。

### 2.4 设置项

```ts
downloadSource: DownloadSource   // 默认 'auto'
downloadThreads: number          // 1..16，默认 4（单文件分片数）
```

`settings.patch` 接受这两个字段；`downloadSource: 'auto'` 时首次下载前用 800ms 超时探测 `https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json`，通就用镜像，否则官方，结果缓存 10 分钟。

### 2.5 镜像 URL 重写（mojang.ts 内的纯函数，便于单测）

```ts
export function mirrorUrl(url: string, source: DownloadSource): string
```
映射规则（`source === 'bmclapi'`）：
- `launchermeta.mojang.com/*`、`piston-meta.mojang.com/*`、`piston-data.mojang.com/*`、`launcher.mojang.com/*` → `https://bmclapi2.bangbang93.com/*`
- `resources.download.minecraft.net/<a>/<hash>` → `https://bmclapi2.bangbang93.com/assets/<a>/<hash>`
- `libraries.minecraft.net/<path>` → `https://bmclapi2.bangbang93.com/maven/<path>`
- 其他域名（Modrinth 等）原样返回。

`source === 'official'` 或未知 → 原样返回。所有下载 spec 的 url 在创建前统一过一遍 `mirrorUrl`。

### 2.6 mojang install 的阶段与加权

阶段顺序与权重（整体 percent = 各阶段完成比例 × 权重之和）：

| stage | label | 权重 |
|---|---|---|
| version | 下载版本信息 | 5% |
| libraries | 下载库文件 | 30% |
| assets | 下载资源文件 | 60% |
| logging | 下载日志配置 | 5% |

每 200ms 发一次 progress（含 `stages` 快照、`currentFile`、`speed`、`etaMs`、`percent`、`source`）。完成时 `stage: 'done'`, `percent: 100`。

## 3. 前端（src/renderer，Lead 负责）

- `ProgressCard`：PCL 式——大百分比 + 阶段清单（✓/进行中/待办）+ 速度 + 已下/总量 + 剩余时间 + 当前文件 + 「取消」按钮。
- `VersionPicker`：游戏版本 + 三种加载器可用版本（`loaders.available`）清晰展示，选好一键「装原版 + 装加载器」。
- `ModsDialog`：每个模组显示「支持 1.20.1 · Fabric」chips，不兼容当前实例的置灰并提示原因。

## 4. 验收

- `npm run typecheck` 通过。
- `npm run smoke` 通过（不破坏既有断言）。
- 新增 `scripts/p28-check.mjs`：真实下载同一文件（取一个 ~5MB 的 library），对比 `official` / `bmclapi` 两种源的耗时与速度，输出表；断言分片下载结果 sha1 正确。
- 截图：`out/smoke-download.png`（下载进行中）、`out/smoke-loader.png`（加载器可用性面板）。

---

## 5. P28.1 追加契约（Lead 补充，后端已实现）

### 5.1 installer 服务（一键装 + 绑定实例）

```ts
window.qdo.installer.run(req: {
  instanceId: string
  gameVersion: string
  loader?: 'vanilla' | 'fabric' | 'forge' | 'neoforge'   // 默认 'vanilla'
  loaderVersion?: string                                  // 为空取 recommended
}): Promise<{ ok: boolean; versionId?: string; loader?: string; loaderVersion?: string; ms?: number; error?: string }>
```

IPC：`CH.installerRun`。后端 `src/main/plugins/installer.ts`，复用 mojang/loaders 的 progress sink（不重复发事件）。成功后调用 `instances.setVersion(instanceId, versionId, gameVersion, gameVersion, loader)`；异常不抛出 IPC。

### 5.2 loaders.available 的 Fabric 版本

`versions` 过滤 `-beta` 但保留非 stable 的历史正式版（新→旧，≤20）；`recommended` 优先 stable，没有则取第一个非 beta。`installFabric(gameVersion, versionOverride?)` 支持显式 loader 版本，默认选择逻辑（stable → 最新）不变。

### 5.3 SearchHit 兼容字段

`content.search()` 把 Modrinth v2 `/search` 的 `versions`（游戏版本）映射为 `gameVersions`、`loaders` 映射为 `loaders`；原有 `versions` 字段名保留。

### 5.4 自动选源改为吞吐探测（替代原 2.4 的 800ms TTFB 探测）

`downloadSource: 'auto'` 时并行下载官方 / BMCLAPI 的 `version_manifest_v2.json`（单请求超时 6000ms），按完整 body 实测吞吐 KB/s 判定：

- 两者都成功：`bmclapi ≥ official × 0.8` → bmclapi（国内优先），否则取更快的；
- 只有一个成功：用它；都失败：official（静默，不向用户报错）；
- 结果缓存 15 分钟，并发只探测一次；探测不计入 progress；
- 日志：`log.info('mojang','下载源探测',{ official: 'x KB/s', bmclapi: 'y KB/s', chosen })`；
- `DownloadSpec` 内部新增 `fallbackUrl`：镜像 403/404/连不上时单文件自动改用官方地址重试（不做整批切源）。
