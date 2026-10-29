# P29 规格：PCL 式下载中心 + 文件级进度 + 预览 + 模组更新检查

本文件是 P29 的唯一接口契约。**后端只按第 1、2 节实现；前端（Lead）不动第 2 节签名。**

## 0. 背景

用户反馈：下载界面「太杂乱」，要「学习 PCL / 照搬 PCL」。所以要：

1. **下载中心**：独立页面，左侧分类（游戏 / 模组 / 资源包 / 光影 / 整合包），顶部搜索，右侧列表；点安装后自动切到「下载任务」页，**按文件列出每个文件的状态**（PCL 就是这样的）。
2. **补上两个没做的功能**：
   - 整合包下载进度（当前只有单文件模组的 toast，整合包几十个文件没有任何进度）
   - 资源包/光影的**图片预览**
   - 模组**更新检查**（已装模组 vs Modrinth 最新版，可一键更新）

## 1. 共享类型（src/shared/types.ts，全部为新增，不破坏旧字段）

```ts
/** 下载任务里的单个文件（PCL 式文件清单） */
export interface ProgressFile {
  /** 显示名：库坐标 / mod 文件名 / assets 的 key */
  name: string
  /** 字节数，未知省略 */
  size?: number
  /** 该文件当前状态 */
  state: 'pending' | 'running' | 'done' | 'failed' | 'skipped'
}

/** TaskProgress 追加（可选字段） */
export interface TaskProgress {
  // ...已有字段不动
  /** 当前阶段的文件清单（最多 200 条，按 PCL 的样式逐行显示） */
  files?: ProgressFile[]
  /** 任务标题，例如「安装 1.21.11」「安装整合包 Fabulously Optimized」 */
  title?: string
}

/** 模组更新项 */
export interface ContentUpdate {
  /** 实例内的文件名（mods/ 下） */
  fileName: string
  projectId?: string
  title?: string
  /** 当前版本号（来自 content.json） */
  currentVersion?: string
  /** Modrinth 上的最新版本号 */
  latestVersion?: string
  /** 最新文件名（覆盖安装用） */
  latestFileName?: string
  gameVersions?: string[]
  loaders?: string[]
}

/** 资源预览（图片画廊） */
export interface ContentPreview {
  projectId: string
  title: string
  description: string
  iconUrl?: string
  /** 画廊图片（绝对 https URL，前端直接 <img>） */
  gallery: string[]
  downloads: number
  gameVersions: string[]
  loaders: string[]
}
```

## 2. 后端 API

### 2.1 下载器（src/main/lib/downloader.ts）

```ts
export interface DownloaderOptions {
  // ...已有
  /** 下载开始前回调一次：本次要下的文件清单 */
  onFiles?: (files: { name: string; size?: number }[]) => void
  /** 单文件状态变化（含 running/done/failed/skipped），index 为 files 下标 */
  onFileState?: (index: number, state: ProgressFile['state']) => void
}
```

要求：
- `downloadAll()` 开始时调一次 `onFiles(specs.map(...))`（name 用 `spec.label ?? basename(spec.dest)`）。
- 每个文件开始下载前 `onFileState(i,'running')`，完成 `'done'`，校验命中跳过 `'skipped'`，重试耗尽 `'failed'`。
- 状态回调需要节流（≥100ms 合并一次），不要每个字节都发。

### 2.2 mojang 安装（src/main/plugins/mojang.ts）

`install()` 的 progress 事件追加：
- `title: '安装 <versionId>'`
- `files`: 当前阶段的文件清单（libraries 阶段是全部库，assets 阶段取前 200 个并按完成度滚动窗口也行），状态由下载器回调维护。
- 旧字段（stage/done/total/bytes/percent/speed/etaMs/currentFile/stages）保持不变。

### 2.3 内容安装（src/main/plugins/content.ts）

`installPack()` / `installModpack()` / `installModpackProject()` / `install()` 在下载文件时都要发 progress：

- `kind: 'content'`
- `stage: 'content'`，`message` 用「安装整合包 X」
- `title: '安装整合包 <name>'`（模组单个文件则 `'安装模组 <title>'`）
- `files` / `filesDone` / `filesTotal` / `bytesTotal` / `speed` / `etaMs` / `percent`
- 完成发 `stage:'done'`，失败发 `stage:'failed'`（新增 stage 值，已在 `InstallStage` 里加 `'cancelled'` 的旁边加 `'failed'`）

### 2.4 模组更新检查

```ts
ctx.provide('content', {
  // ...已有
  /** 检查实例内已装模组的最新版本（Modrinth）。没有可更新的返回空数组 */
  updates(instanceId: string): Promise<ContentUpdate[]>
  /** 把某个模组更新到最新（下载新文件 → 删除旧文件 → 更新 content.json） */
  update(instanceId: string, fileName: string): Promise<{ ok: boolean; fileName?: string; version?: string; error?: string }>
  /** 资源/光影/模组的图片画廊预览 */
  preview(projectId: string, kind: ContentKind): Promise<ContentPreview>
})
```

实现要点：
- `updates()`：
  1. 读 `content.json` 里该实例已装的 `mod` 项；
  2. 对 `mods/<fileName>` 计算 **sha1**；
  3. `POST https://api.modrinth.com/v2/version_files/update`，body `{ hashes: [...], algorithm: 'sha1', loaders: [当前加载器], game_versions: [当前游戏版本] }`（Modrinth 官方接口，返回 hash → 最新 version 对象）；
  4. 只保留 `version_number` 与原记录不同、且 `files` 里能挑出主文件的项，映射成 `ContentUpdate`；
  5. 单个网络错误不要整体抛错：日志 warn + 返回能拿到的部分（或空数组 + 给 UI 一个 `error` 提示的方式由前端 toast 处理，后端返回 `[]` 即可）。
- `update()`：下载 `latest` 的 primary 文件到 `mods/`（旧文件先改名 `.old`，成功后删除），更新 `content.json` 对应项的 `versionId/versionNumber/fileName`，失败回滚。
- `preview()`：`GET https://api.modrinth.com/v2/project/<id>`，取 `gallery`（元素 `{ url, featured }`，url 可能是 `//cdn.modrinth.com/...`，要补 `https:`）、`icon_url`、`description`、`downloads`、`game_versions`、`loaders`。失败返回空 gallery + 描述为空，不抛错。

### 2.5 IPC / preload / channels

```ts
CH.contentUpdates      'content:updates'
CH.contentUpdate       'content:update'
CH.contentPreview      'content:preview'
// preload
content.updates(instanceId): Promise<ContentUpdate[]>
content.update(instanceId, fileName): Promise<{ ok, ... }>
content.preview(projectId, kind): Promise<ContentPreview>
```

## 3. 前端（Lead 负责，仅列出来对齐）

- 新 `DownloadCenter.tsx`：PCL 式布局——左侧分类竖排（游戏/模组/资源包/光影/整合包 + 分隔 + 「下载任务」），顶部搜索框，列表卡片带图标/描述/支持版本/安装按钮，点击右侧「安装」；
- 安装后自动切到「下载任务」页：顶部大百分比 + 速度 + 剩余时间 + 总进度条，下面**逐文件清单**（✓ 已完成 / ▶ 下载中 / ○ 等待 / ✗ 失败），可取消；
- 主界面不再内联下载面板（解决「杂乱」）；
- 模组面板加「检查更新」按钮，列出可更新项 + 逐个/全部更新；
- 资源包/光影列表点卡片出预览图（画廊首图 + 描述）。

## 4. 验收

- `npm run typecheck` / `npm run build` 通过。
- 隔离数据目录 `npm run smoke` 通过，且有：
  - 下载任务页截图（文件清单可见）
  - 整合包安装的 progress 事件里有 `files` 且 `filesDone` 递增
  - `updates()` 对已装两个模组的实例返回数组（可空，但不能抛错）
  - `preview()` 对任意 Modrinth 项目返回 gallery（可能为空）
- 报告里贴：整合包安装的 progress 采样（前 3 次 + 最后一次）、updates 实测结果、preview 实测 URL。
