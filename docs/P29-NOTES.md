# P29 后端实现说明（PCL 式文件级进度 + 预览 + 模组更新检查）

> 实现者：后端（dl2）。契约：`docs/P29-SPEC.md` 第 1、2 节。
> 本机环境：Windows 11 / Node 24.15 / Electron 43 / esbuild 0.28，网络经 CERNET 中转。
> 未改动：`src/renderer/**`、`src/main/index.ts`（`--smoke` 步骤序列一行未动）、`scripts/build.mjs`、`docs/P29-SPEC.md`。

## 0. 验收结果速览

| 项目 | 结果 |
|---|---|
| `npm run typecheck` | 通过（strict，0 error） |
| `npm run build` | 通过（out/ 全部产物）；收尾时 Lead 正在跑截图，最后只补了 `typecheck` + 临时目录 esbuild bundle 校验（不改 out/） |
| `node scripts/p29-check.mjs` | 通过（a 下载器文件级进度 / b preview / c updates / e update；额外 d 整合包 progress 采样） |
| 隔离 smoke（`npx electron . --smoke`） | 通过：`SMOKE_RESULT {"ok":true,"ms":151628,"failed":[]}`（27 插件 0 失败） |

## 1. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/shared/types.ts` | 新增 `ProgressFile`；`TaskProgress` 追加可选 `files` / `title`；新增 `ContentUpdate` / `ContentPreview`；`InstallStage` 追加 `'failed'`（`'cancelled'` 保持） |
| `src/shared/channels.ts` | 新增 `CH.contentUpdates` / `CH.contentUpdate` / `CH.contentPreview` |
| `src/shared/api.ts` | `QdoApi.content` 增 `updates` / `update` / `preview`，同步 `QdoApi` 类型 |
| `src/preload/index.ts` | 暴露上述三个调用（与 api.ts 一致） |
| `src/main/lib/downloader.ts` | `DownloaderOptions` 新增 `onFiles` / `onFileState`；`downloadAll()` 开始发一次文件清单；每文件 `running → done/skipped/failed`；状态回调 ≥100ms 合并（`FILE_STATE_INTERVAL_MS=120`，结束强制 flush）；`fetchOne()` 也复用同一套（单文件安装也有进度） |
| `src/main/plugins/mojang.ts` | `install()` 的 progress 追加 `title:'安装 <versionId>'` 与当前阶段 `files`（libraries 全量前 200 / assets 前 200 / 索引与 logging 阶段单独一条）；失败时发一次 `stage:'failed'`；旧字段全部保持 |
| `src/main/plugins/content.ts` | 新增 `setProgressSink()`；`install()` / `installVersion()` / `installModpack()` / `installModpackProject()` / `installCursePack()` / `installPack()` 都发 `kind:'content', stage:'content'|'done'|'failed'` 的进度（title/files/filesDone/filesTotal/bytesTotal/speed/etaMs/percent）；新增 `updates()` / `update()` / `preview()` |
| `src/main/plugins/ipc.ts` | 注册 3 个新 IPC；`content.setProgressSink(...)` 接入 `EVT.progress`（否则内容安装进度到不了 UI） |
| `scripts/p29-check.mjs` | 新增验收脚本（esbuild 临时 entry，跑完删除） |
| `docs/P29-NOTES.md` | 本文件 |

## 2. 三组新 API 最终签名（与 SPEC 一致）

```ts
// preload：window.qdo.content
updates(instanceId: string): Promise<ContentUpdate[]>
update(instanceId: string, fileName: string):
  Promise<{ ok: boolean; fileName?: string; version?: string; error?: string }>
preview(projectId: string, kind: ContentKind): Promise<ContentPreview>
// ContentKind = 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'datapack'
// 便捷写法：preview(projectId, 'mod' | 'resourcepack' | 'shader' | 'modpack' | 'datapack')
```

`ContentUpdate`：`{ fileName, projectId?, title?, currentVersion?, latestVersion?, latestFileName?, gameVersions?, loaders? }`
（`fileName` = 实例 `mods/` 下的现有文件名；`latestFileName` = 最新版主文件名，覆盖安装用）

`ContentPreview`：`{ projectId, title, description, iconUrl?, gallery: string[], downloads, gameVersions, loaders }`
（`gallery` 全是绝对 `https://`，`//cdn.modrinth.com/...` 已补 `https:`）

进度事件（`window.qdo.onProgress`）新增可选字段：

```ts
files?: ProgressFile[]   // { name, size?, state: 'pending'|'running'|'done'|'failed'|'skipped' }，最多 200 条
title?: string           // 「安装 1.21.11」「安装整合包 Fabulously Optimized」
```

安装失败时多一个 `stage: 'failed'`（原版安装与内容安装都发一次；`stage:'cancelled'` 行为不变）。

## 3. 关键实现细节

### 3.1 下载器文件级进度（`downloader.ts`）
- `downloadAll()` 在开始并发前调一次 `onFiles(specs.map(...))`，`name = spec.label ?? basename(spec.dest)`；
- 每个文件派发前 `onFileState(i,'running')`；`fetchInternal` 返回 `skipped` → `'skipped'`，成功 → `'done'`，重试耗尽 → `'failed'`；
- 单文件状态用 `Map<index,state>` 合并：同一窗口只保留最新状态，`≥120ms` flush 一次，结束时强制 flush（不会逐字节刷 IPC；`fetchOne` 单文件也走同一套）；
- 取消（AbortError）不发 `failed`，避免把用户取消误报为失败。

### 3.2 原版安装进度（`mojang.ts`）
- `title` 固定 `安装 <versionId>`；`files` 跟随阶段：`libraries` 全量前 200、`assets` 前 200（SPEC 允许「按完成度滚动窗口也行」，这里取前 200，`filesDone/filesTotal` 仍是全量计数）、资源索引/日志配置阶段各一条；进入 `logging` 阶段清空清单避免串台；
- 每次 `emit()` 都带 `files`（下载器状态回调用 120ms 合并后触发 `emit`，`emit` 自身 200ms 节流，完成/切阶段 force）；
- 失败（非取消）`emit('failed', true, message)`，前端可把卡片刻成失败但保留已下文件供续传。

### 3.3 内容安装进度（`content.ts`）
- 新增 `ContentTask`：`taskId/title/message/files/bytes/bytesTotal/speed/etaMs/lastEmit`；`emitTask()` 200ms 节流，`stage:'done'` 强制 `percent:100`；
- `downloadWithTask()` 复用 `Downloader` 的 `onFiles/onFileState/onProgress`，把「已下字节/总字节」折算 `percent`；支持一个任务里多次下载（依赖递归、CurseForge 先解析后下载）时文件清单累加；
- **`files[].size`**：mrpack 用 `fileSize`、单个模组用 Modrinth `files[].size`、CurseForge 用 CF API 的 `fileLength`；单文件安装也有清单；
- 单文件（模组/资源包/光影）：`title = 安装<模组|资源包|光影> <项目名>`，依赖也进同一份清单；
- `.mrpack`：`title = 安装整合包 <name>`，loader 安装阶段先发一条 0 文件的进度（UI 立刻能看到标题），随后逐文件 `pending → running → done`；完成 `stage:'done'`；
- CurseForge `.zip`：包内自带 mods 直接记 `done`；manifest 文件先按 `fileID` 逐个解析（每 10 个发一条「解析文件 x/n」的 message），再统一并发下载并发逐文件状态——不是只做 Modrinth 路径；
- `installPack()` / `installModpackProject()` 在识别失败/没有可下载文件时也会发一次 `stage:'failed'`。

### 3.4 模组更新检查（`updates()`）
1. 读 `content.json`，只取 `kind==='mod'` 且文件名是 `mods/` 下的简单文件名（跳过 .mrpack/CurseForge 记录的带路径项）；
2. 对 `mods/<fileName>`（含 `.disabled`）用 `node:crypto` 算 **sha1**；
3. `POST https://api.modrinth.com/v2/version_files/update`，body `{ hashes, algorithm:'sha1', loaders:['fabric'|...], game_versions:[当前版本] }`；
4. 只保留 `version_number` 与原记录不同、且 `files` 里能挑出主文件的项，映射为 `ContentUpdate`；
5. 项目标题再 `GET /projects?ids=[...]` 一次性补（失败只 warn，`title` 是可选字段）；
6. 整体 try/catch：任何一批网络错误 → 日志 warn + 返回 `[]`（不抛错），前端按空数组处理。

### 3.5 单个更新（`update()`）
顺序严格按 SPEC：查最新版 → 旧文件改名 `.old` → 下载新文件（新文件名可能不同）→ 成功后删 `.old` → 更新 `content.json`（`versionId/versionNumber/fileName/sha1`）。
- 下载失败：删掉新文件、把 `.old` 改回原名，返回 `{ok:false,error}`；
- `content.json` 保存失败：删新文件、恢复旧文件，返回失败；
- 原本被禁用（`.jar.disabled`）的模组更新后仍保持禁用；
- 同名覆盖时旧文件先被改名，所以磁盘上不会出现两个同名文件；结束后无 `.old` / `.part` 残留（p29-check e 步骤断言）。

### 3.6 预览（`preview()`）
- 只打 `GET /v2/project/<id>`；取 `gallery[].url`（协议相对补 `https:`）、`icon_url`、`description`、`downloads`、`game_versions`、`loaders`；
- 任何网络/解析失败 → 日志 warn + 返回空画廊空描述，不抛错。

## 4. p29-check 实测输出（2026-10-29，本机真实网络）

脚本：`node scripts/p29-check.mjs`（`--no-pack` 可跳过 d 步骤；`--keep` 保留临时数据目录）。

```
[p29-check] 原数据目录（只读）: C:\Users\ew147\AppData\Roaming\QDOQMC
[p29-check] 采样实例: default（游戏版本 1.21.11）
=== a) 下载器文件级进度（3 个真实 library） ===
  onFiles: 1 次 / 3 个文件；onFileState: 6 次（3 个合并批次，≥100ms 节流）
  stats: {"downloaded":3,"skipped":0,"bytes":28078,"failed":0}，耗时 279ms
┌─────────┬───────┬────────────────────────────────────────┬─────────┬────────────────┐
│ (index) │ index │ name                                   │ size KB │ state          │
├─────────┼───────┼────────────────────────────────────────┼─────────┼────────────────┤
│ 0       │ 0     │ 'com.mojang:patchy:2.2.10'             │ 4       │ 'running→done' │
│ 1       │ 1     │ 'com.google.guava:failureaccess:1.0.3' │ 11      │ 'running→done' │
│ 2       │ 2     │ 'com.mojang:jtracy:1.0.37'             │ 13      │ 'running→done' │
└─────────┴───────┴────────────────────────────────────────┴─────────┴────────────────┘
=== b) content.preview("sodium", "mod") ===
  gallery: 6 张；首个 URL: https://cdn.modrinth.com/data/AANobbMI/images/d84313e6f57dc9e7896961dbd2dfc2689d482758_350.webp
  preview: {"projectId":"AANobbMI","title":"Sodium","downloads":256896505,
            "gameVersions":["1.16.3","1.16.4","1.16.5","1.17","1.17.1","1.18"],
            "loaders":["fabric","neoforge","quilt"]}
=== c) content.updates("default") ===
  checked: 2 个已装模组 → 返回 1 项
  [{"fileName":"sodium-fabric-0.8.14+mc1.21.11.jar","projectId":"AANobbMI","title":"Sodium",
    "currentVersion":"mc1.21.11-0.8.14-fabric",
    "latestVersion":"mc1.21.11-0.8.15-beta.1-fabric",
    "latestFileName":"sodium-fabric-0.8.15-beta.1+mc1.21.11.jar",
    "gameVersions":["1.21.11"],"loaders":["fabric"]}]
  （fabric-api 无更新，未出现在数组里；返回数组不抛错）
=== e) content.update("default") ===
  update(sodium-fabric-0.8.14+mc1.21.11.jar) ->
    {"ok":true,"fileName":"sodium-fabric-0.8.15-beta.1+mc1.21.11.jar","version":"mc1.21.11-0.8.15-beta.1-fabric"}
  mods/ 实测: {"newFile":"sodium-fabric-0.8.15-beta.1+mc1.21.11.jar","oldFileRemoved":true,"leftoverTemp":[],"rows":2}
=== d) 整合包安装 progress 采样（本地 .mrpack，2 个真实文件 + fabric-loader） ===
  共 46 条 content progress；前 3 条采样：
  {"stage":"content","title":"安装整合包 P29 Check Pack","message":"安装整合包 P29 Check Pack",
   "filesTotal":0,"filesDone":0,"percent":0,"showing":0,"sizesKnown":"0/0","bytesTotal":0}
  {"stage":"content","title":"安装整合包 P29 Check Pack","message":"安装整合包 P29 Check Pack",
   "filesTotal":2,"filesDone":0,"percent":0,"showing":2,"sizesKnown":"2/2","firstSize":2426039,"bytesTotal":4335189}
  {"stage":"content","title":"安装整合包 P29 Check Pack","message":"安装整合包 P29 Check Pack",
   "filesTotal":2,"filesDone":0,"percent":0,"showing":2,"listedRunning":2,"sizesKnown":"2/2","bytesTotal":4335189,"speed":4474,"etaMs":968660}
  下载中样本（filesDone 递增）：
  {"stage":"content","filesTotal":2,"filesDone":1,"percent":88.7,"listedDone":1,"listedRunning":1,"sizesKnown":"2/2","firstSize":2426039,"speed":436462,"etaMs":1127}
  最后一次：{"stage":"done","title":"安装整合包 P29 Check Pack","message":"安装完成","filesTotal":2,"filesDone":2,"percent":100,"sizesKnown":"2/2"}
  实测：files 带 size 2/2 个；filesDone 递增序列 [0,1,2]
  安装结果: {"instanceId":"p29-check-pack","packName":"P29 Check Pack","files":2,"bytes":4335189,"loader":"fabric","mcVersion":"1.21.11"}
```

注：a 步骤的 3 个文件从 `%APPDATA%\QDOQMC\versions\1.21.11\1.21.11.json` 里挑真实 library URL；c/e 的实例是从原目录**只读复制**到临时目录的副本，原目录零写入。
b 步骤对 `sodium` 实测 gallery=6；`fabric-api` 这类项目 Modrinth 本身没有 gallery 图（实测 0 张），preview 返回空数组属正常，smoke 里点到的恰好是无图项目。

## 5. 隔离 smoke

命令（**cwd 必须是临时目录**，否则截图会写进仓库 `out/` 覆盖 Lead 的截图；本次踩过这个坑）：

```powershell
$wd = "$env:TEMP\qdo-p29-shot"; New-Item -ItemType Directory -Force -Path $wd | Out-Null
$env:QDOQMC_DATA_DIR="$env:TEMP\qdo-p29\data"; $env:QDOQMC_USER_DATA="$env:TEMP\qdo-p29\ud"
Start-Process -FilePath "D:\QDOQMC\node_modules\electron\dist\electron.exe" `
  -ArgumentList ".", "--smoke" -WorkingDirectory $wd `
  -RedirectStandardOutput "$env:TEMP\qdo-p29-smoke.log" -PassThru -NoNewWindow
```

实测结果：进程正常退出，`SMOKE_RESULT`：

```
ok=true  ms=151628  failed=[]   （27 个插件全部加载，0 失败）
```

该轮 smoke 数据目录为 `%TEMP%\qdo-p29\{data,ud}`，未污染原数据目录。UI 相关断言（下载中心/模组弹窗等）由 Lead 用同一份后端自己截图验证；本后端只确认「能跑完 + failed 为空」。

## 6. 与 SPEC 的差异 / 补充说明

1. **新增 `content.setProgressSink()`**（SPEC 2.4 未列）：内容安装进度必须有 IPC 出口，做法与 `mojang.setProgressSink` 一致；`ipc.ts` 已接入 `EVT.progress`。纯新增，已有方法签名未变。
2. **文件清单上限**：`files` 最多 200 条（SPEC 1 允许「最多 200 条」）；`libraries`/`assets` 都取前 200，`filesDone/filesTotal` 仍是全量计数，前端用后者算百分比/完成度。
3. **`updates()` 的「最新版」包含 beta**：`/version_files/update` 返回的是 Modrinth 认为的最新兼容版本（本次 sodium 返回 `0.8.15-beta.1`），SPEC 未要求按 `version_type` 过滤，故原样返回；如需「只提示正式版」可在前端按 `latestVersion` 过滤或后续加 `version_type` 过滤（会与 SPEC 的「最新版本」措辞略有出入，未擅自改）。
4. **CurseForge 路径也做了逐文件进度**（任务要求 3）：包内自带 mods 直接标 `done`；manifest 文件先解析（message 显示「解析文件 x/n」）再并发下载，逐文件发 `running/done`；文件 `size` 取 CF API 的 `fileLength`。
5. 下载器的 `onFiles` / `onFileState` 对 `fetchOne()` 也生效（SPEC 只要求 `downloadAll()`；单文件模组安装因此也有文件清单/状态）。
6. `update()` 保留原 `.disabled` 状态；`preview()` 把 `http://` 强制升级为 `https://`（SPEC 只要求 `//` 补协议）。
7. p29-check 在 SPEC 要求的三项之外，额外做了 **e) `update()` 实测** 与 **d) 整合包 progress 采样**（本机真实网络，约 60s），用于自证任务书里的「整合包 progress 前 3 次采样」。
8. **`preview()` 对无截图的项目返回 `gallery: []` 是正常行为**：`sodium` 实测 6 张；`fabric-api` 在 Modrinth 上本身没有 gallery（实测 0 张），smoke 里点到的恰好是无图项目，不是实现没取到 `.url`。
