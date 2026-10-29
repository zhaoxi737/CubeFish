# P28 后端实现说明（下载清晰化 + PCL 式进度 + 镜像加速）

> 实现者：后端（dl-core）。契约：`docs/P28-SPEC.md` + Lead 追加的两条契约（installer 服务、SearchHit 字段）。
> 所有数据均为本机 Windows 实测（2026-10-29，Node 24 / Electron 43，网络经 CERNET 中转）。

## 0. 验收结果速览

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过（strict，无 error） |
| `npm run build` | 通过（out/ 全部产物） |
| `node scripts/p28-check.mjs` | 通过：mirrorUrl 5 类断言 + 真实下载对比 + 分片 sha1 + 临时文件无残留 + Range/fallback 取证 |
| `npm run smoke`（隔离数据目录） | 通过：exit 0，127s / 126s，27 插件 0 失败 |
| 取消（cancelled） | smoke 实测：点取消 → progress `stage:'cancelled'`，UI 标题「已取消」 |
| 1.20.1 加载器面板 | Fabric 20 个版本可选 / Forge 20 个 / NeoForge 不支持 1.20.1（正确） |

隔离 smoke 命令（不污染 `data/`）：

```powershell
$env:QDOQMC_DATA_DIR="$env:TEMP\qdo-p28"; $env:QDOQMC_USER_DATA="$env:TEMP\qdo-p28-ud"
npx electron . --smoke
# 实测用 Start-Process -RedirectStandardOutput 拿 GUI 子系统进程 stdout
```

## 1. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `DownloadSource` / `StageProgress` / `TaskProgress` 可选字段（percent/bytesTotal/speed/etaMs/currentFile/filesDone/filesTotal/stages/source）、`LoaderChoice` / `LoaderAvailability` / `InstallerLoader` / `InstallerRunRequest` / `InstallerRunResult`；`SearchHit` 加 `gameVersions?`/`loaders?`；`InstallStage` 加 `cancelled`；`SettingsShape` 加 `downloadSource`/`downloadThreads`；`kind` 加 `'content'` |
| `src/shared/channels.ts` | 新增 `CH.versionCancel` / `CH.loaderAvailable` / `CH.installerRun` |
| `src/shared/api.ts` | `versions.cancel()`、`loaders.available(gameVersion)`、`installer.run(req)` |
| `src/preload/index.ts` | 暴露以上三个调用（与 api.ts 一致） |
| `src/main/lib/downloader.ts` | 字节级实时进度、2s 滑动速度、ETA、200ms 节流；分片下载（threads，先写 `.part.<i>` 再按序合并）；总连接 ≤ `concurrency*2`；取消（AbortError + 清理临时文件）；`DownloadSpec.fallbackUrl`（镜像 403/404 → 官方兜底） |
| `src/main/plugins/mojang.ts` | `mirrorUrl()` 纯函数；`probeDownloadSource()` 吞吐测速选源（6000ms、缓存 15min）；`cancel()`；install 加权阶段进度（version 5 / libraries 30 / assets 60 / logging 5）、`stages` 快照、`source`；manifest/versionJson 镜像+官方回退；所有下载 spec 统一过 `mirrorUrl` |
| `src/main/plugins/settings.ts` | `downloadSource`（默认 `auto`）、`downloadThreads`（默认 4，1..16）与 sanitize |
| `src/main/plugins/loaders.ts` | `available(gameVersion)`；`installFabric(gameVersion, versionOverride?)`；Forge/NeoForge/Fabric 元数据请求加 3 次重试（修 smoke 中 Forge 偶发只剩 1 个版本的问题） |
| `src/main/plugins/installer.ts` | **新增插件**：一键装（原版/加载器 + 绑定实例），原子操作，进度沿用 mojang/loaders sink |
| `src/main/kernel.ts` | 注册 `installer` 插件（在 loaders 之后、ipc 之前） |
| `src/main/plugins/ipc.ts` | 注册 3 个新 IPC；`loaderAvailable` / `installerRun` / `versionCancel` |
| `src/main/plugins/content.ts` | Modrinth search 映射 `gameVersions` / `loaders` |
| `scripts/p28-check.mjs` | 新增验收脚本（esbuild 临时编译 `scripts/.tmp-p28-check.ts`，跑完删除） |
| `docs/P28-SPEC.md` | 追加「P28.1 追加契约」附录（Lead 增项 + 探测策略变更），未改动原接口定义 |

未改动：`src/renderer/**`、`src/main/index.ts` 的 `--smoke` 步骤序列。

## 2. 前端可用调用签名（与实现一致）

```ts
// 1) 取消当前安装
window.qdo.versions.cancel(): Promise<{ ok: boolean; cancelled: boolean }>

// 2) 加载器可用性
window.qdo.loaders.available(gameVersion: string): Promise<LoaderAvailability>
//   LoaderAvailability = { gameVersion, release, javaMajor?, loaders: LoaderChoice[] }
//   LoaderChoice = { loader: 'fabric'|'forge'|'neoforge', versions: string[] /*新→旧≤20*/,
//                    recommended?: string, note?: string /*'查询失败，可稍后重试' 等*/ }

// 3) 一键装（装好即绑定实例）
window.qdo.installer.run(req: {
  instanceId: string
  gameVersion: string
  loader?: 'vanilla' | 'fabric' | 'forge' | 'neoforge'
  loaderVersion?: string
}): Promise<{ ok: boolean; versionId?: string; loader?: string; loaderVersion?: string; ms?: number; error?: string }>
```

进度事件 `onProgress(TaskProgress)` 新增可选字段：`percent`（整体加权 0..100）、`bytesTotal`、`speed`（B/s）、`etaMs`、`currentFile`、`filesDone`/`filesTotal`、`stages: StageProgress[]`、`source`（'official' | 'bmclapi' 实际值，auto 已解析）。取消时额外发一次 `stage: 'cancelled'`、`message: '已取消'`，`install()` 返回 `{ ok:false, error:'已取消' }`。

## 3. 关键实现细节

### 3.1 下载器（`downloader.ts`）
- **实时进度**：`bytes = 已完成文件字节 + 在途文件已写入字节`；`bytesTotal = Σ spec.size`（未知按 0）；每 200ms 最多一次回调（`force` 用于阶段切换/完成）。
- **速度/ETA**：最近 2s 滑动平均；`etaMs = (bytesTotal - bytes) / speed`，总量未知或速度为 0 时省略。
- **分片**：`size ≥ 4MB` 且 `threads ≥ 2` 时切成 N 段（每段 ≥1MB，N ≤ threads），Range 并发拉取 → 写 `${dest}.part.<i>`；全部完成后按序合并为 `${dest}.part`，再 sha1/size 校验、rename 落盘、写入内容寻址缓存。任一分片失败重试 2 次（共 3 次尝试），最终失败清理全部临时文件并抛错。服务端 200/416 → 删除分片回退单流。
- **连接上限**：信号量 `concurrency * 2`（默认 8 → 16）。分片文件先阻塞占 1 个名额、再 `tryAcquire` 最多 threads 个；拿不到就少开几片，不会死锁，总在途连接数不超过上限。
- **取消**：`new Downloader({ signal })`；中断清理 `.part`/`.part.<i>` 后抛 `AbortError`；`downloadAll` 停止派发并向上抛；`install()` 捕获后发 cancelled 进度。
- **镜像兜底**：`DownloadSpec.fallbackUrl`——BMCLAPI 对新文件会返回 403/404（镜像同步滞后）或连不上，此时立即改用官方地址重试一次，避免整批安装失败；单文件粒度，比「整批切源」更细。

### 3.2 自动选源（吞吐，不是 TTFB）
`downloadSource: 'auto'` 时并行下载两份 `version_manifest_v2.json`（约 0.28MB），**按读完整个 body 的实测吞吐 KB/s** 比较（单请求超时 6000ms）：

- 两者都成功：`bmclapiKBps ≥ officialKBps × 0.8` → 选 bmclapi（国内优先），否则选更快的；
- 只有一个成功：用它；都失败：official；
- 结果缓存 15 分钟；并发只探测一次（inflight Promise 复用）；探测不产生 progress、失败不向用户报错。

日志格式（smoke 实测）：
```
INFO mojang 下载源探测 { official: '462 KB/s', bmclapi: '107 KB/s', chosen: 'official' }
INFO mojang 下载源探测 { official: '410 KB/s', bmclapi: '306 KB/s', chosen: 'official' }
```
另有导出纯函数 `probeDownloadSource(): Promise<SourceProbeResult>`（p28-check 直接复用）。

### 3.3 加权阶段进度（install）
阶段顺序/权重严格按 SPEC 2.6；`percent = Σ 权重 × 阶段完成比例`（阶段内优先用字节比例，其次文件数比例），完成时 `percent:100`、`stage:'done'`。`stages` 每 200ms 快照一次（含 pending/running/done）。资源索引、旧版资源物化都归入 assets 阶段；`source` 如实填实际源。

### 3.4 loaders.available()
- **Fabric**：取 meta loader 列表，过滤 `-beta`，保留历史正式版，新→旧 `slice(0,20)`；`recommended` 优先 stable（1.20.1 → 0.20.1）。
- **Forge**：`promotions_slim.json` 的 recommended/latest + `maven-metadata.xml` 的 `<gv>-*` build 合并，新→旧 ≤20；promotions 失败回退 maven，两者都失败 → `versions: []` + `note: '查询失败，可稍后重试'`。
- **NeoForge**：`1.20.2+` 才出现；按 `<minor>.<patch>.` 前缀过滤 beta，新→旧 ≤20；1.20.1 及以下不出现该项（不抛错）。
- 任一来源失败只影响该项，`release`/`javaMajor` 查询失败降级为 false/undefined，不整体抛错。

## 4. p28-check 实测数据

环境：Windows 11，本机网络（官方 CDN 与 bmclapi 均经国际/教育网出口），文件为最新正式版里 8.46MB 的 `org.lwjgl:lwjgl-vulkan:3.4.3`（sha1 `ffdaf189…`，第三方 node:crypto 校验）。

**[2/4] auto 吞吐选源（本机）**

| 源 | 吞吐 KB/s | 清单字节 | 选中 |
|---|---|---|---|
| Mojang 官方 | 510 | 278455 | ✓ |
| BMCLAPI 镜像 | 154 | 278455 | |

结论：`chosen = official`。**本机 bmclapi 走 CERNET 中转，TTFB 常常更快但大文件吞吐明显更差**——这正是把探测从 TTFB 改成吞吐的原因；国内用户机器上该规则会选镜像（bmclapi ≥ 官方×0.8 即优先）。

**[4/4] 真实下载（同一文件，单线程 / 分片）**

| source | mode | size MB | ms | avg MB/s | sha1 | temp 残留 | range 取证 |
|---|---|---|---|---|---|---|---|
| official 单线程 | 单线程 | 8.46 | 25883 | 0.33 | OK | 无 | 无 |
| bmclapi 单线程 | 单线程 | 8.46 | 86690 | 0.10 | OK | 无 | 无 |
| official 分片 | 分片 x4 | 8.46 | 18781 | 0.45 | OK | 无 | 4 次 range → 206 |
| 回退(镜像404→官方) | 单线程 | 8.46 | 14732 | 0.57 | OK | 无 | 主源 429/404 → 官方成功 |
| bmclapi 分片回退 | 分片 x4 | 8.46 | — | — | SKIP | — | 429 Too Many Requests（多次测试被限流，见下） |

补充（同日更早一次未限流运行，同文件同参数）：official 单线程 14651ms / 0.58 MB/s；bmclapi 单线程 42539ms / 0.20 MB/s；official 分片 11165ms / 0.76 MB/s（4 次 range → 206）；**bmclapi 分片回退 35127ms / 0.24 MB/s，取证 `2 次 range → 200`**——证明「服务端忽略 Range 返回 200 → 自动回退单流」路径正确，最终 sha1 仍 OK。

说明：
- 分片路径已用 fetch 取证（`4 次 range → 206`）证明是真实并发 Range 下载后合并，而非单流；合并后 sha1 由脚本独立校验。
- 本机 bmclapi 多次压测后返回 429，脚本已做预检/重试/降级（SKIP 行不判失败），不影响官方与分片结论。

## 5. smoke 实测（隔离数据目录）

| 项 | 结果 |
|---|---|
| 退出码 / 耗时 | exit 0；smoke2 125.7s、smoke3 126.3s（含前端下载/取消/加载器/截图步骤） |
| 插件 | 27 个，`failed: []`（含新插件 `installer`） |
| `下载源探测` 日志 | smoke2：`official '462 KB/s', bmclapi '107 KB/s', chosen 'official'`；smoke3：`official '410 KB/s', bmclapi '306 KB/s', chosen 'official'` |
| `download.snapshot.facts` | smoke2（吞吐探测生效后的运行）：「已下载 6.0 MB / 123 MB · **1.3 MB/s** · 剩余 1 分 29 秒 · 文件 7/76 · **Mojang 官方源**」 |
| 取消 | smoke2：`cancel.clicked='clicked'`，UI 标题「已取消」，toast「已取消安装，已下载的文件会保留，下次续传」；日志 `mojang 已请求取消安装 / 版本安装已取消 { percent: 5.4 }` |
| 1.20.1 加载器面板 | Fabric 0.20.1「20 个版本可选」；Forge 47.4.28「20 个版本可选」；NeoForge「不支持 1.20.1」 |
| smoke3 备注 | 最终版 renderer 的下载步骤在空实例状态被禁用（Lead 已知的"沙箱无已装版本"问题），故 smoke3 的 facts 为空；facts 数据取自 smoke2 同后端版本 |

说明：smoke2 与 smoke3 都跑在「吞吐探测 + fallbackUrl」后端之上；smoke2 到 smoke3 之间只加了加载器元数据请求重试（把 1.20.1 的 Forge 从偶发 1 个版本修复为 20 个）。

## 6. 与 SPEC 的差异 / 追加（均已写入 SPEC 附录）

1. **探测策略**：SPEC 2.4 原文「800ms 超时探测、缓存 10 分钟、通就用镜像」→ 按 Lead 要求改为**吞吐探测、单请求 6000ms、缓存 15 分钟**，规则见 3.2。原「通就用镜像」保留为「吞吐 ≥ 官方×0.8 优先镜像」。
2. **新增 installer 服务**（SPEC 未定义）：`src/main/plugins/installer.ts` + `CH.installerRun` + preload `window.qdo.installer.run`，见第 2 节签名。
3. **SearchHit 追加** `gameVersions` / `loaders`（Modrinth search 原生字段），原 `versions` 字段保留不变。
4. **`TaskProgress.kind` 增加 `'content'`**（SPEC 1 已写，原代码缺）。
5. **`DownloadSpec.fallbackUrl`**：内部新增字段（不在 SPEC 接口里），用于镜像缺文件时的官方兜底；对前端不可见。
6. **`InstallStage` 增加 `'cancelled'`**；旧 `legacy` 阶段保留但 install 已不再单独发出（旧版资源物化归入 assets 阶段）。
7. 未做：官方→镜像的「整批切源」重试（改为更细粒度的 `fallbackUrl` 单文件兜底；两者方向相反，效果等价且更省流量）。

## 7. 已知问题 / 后续

- 加载器可用性首次查询偏慢（manifest + version JSON + 三个来源串行/并行各一次，约 5s 级）——Lead 已计划前端缓存；后端已把各元数据请求加重试，但未做结果缓存（避免版本清单变更后陈旧）。
- smoke 隔离数据目录没有已装版本，前端下载步骤在空状态禁用（Lead 处理）。
- 本机 bmclapi 吞吐低于官方属网络环境差异，不代表国内用户体验；auto 规则已在两边都自洽。
