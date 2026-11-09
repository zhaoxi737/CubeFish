# CubeFish / QDOQMC 渲染层 UI 审计（只改外观改版前的安全清单）

- 审计对象：`D:\QDOQMC`，Electron 43 + React 19 + 纯 CSS（esbuild 打 IIFE）
- 审计范围：`src/renderer/**`（只读）、`src/preload/index.ts`、`src/shared/*`、`scripts/*.mjs`、`src/main/index.ts` 中的界面自动化
- 交叉校验：仓库内既有的 `docs/UI-REDESIGN.md` + `docs/ui-mockup/`（见第 7 节，列出 8 处需要修正的冲突）
- 审计方式：全量静态阅读 + 一次性统计脚本（`scripts/_tmp-classcount.mjs`，跑完已删除，数量口径见文末附录）
- 写入约定：本文件是本次审计**唯一**新建/修改的文件；`src/` 未做任何改动（见附录 git 校验）
- 审计时间：2026-11-09

> 口径修正：任务描述里说 `styles.css` 约 3311 行，实测 **3897 行 / 68 008 字节 / 548 条选择器规则 / 345 个 class**。
> 这个差值本身就是一个证据：文件在 P31 之后还继续被追加过（P31 段尾从 3799 一直到 3894）。

---

## 0. 结论先行（给决策用）

1. **界面单元 19 个**（含 2 个纯装饰层）+ 1 个空态：主壳 7 个 + 模态/抽屉 7 个 + 常驻浮层/内嵌卡片 5 个。
   其中「进度卡」**不在** 中间 stage 里，只在 `下载中心 → 下载任务` 页内渲染——改版时最容易凭印象放错位置。
2. **全部交互都由 `App.tsx` 的 23 个 state + 2 个 ref 驱动**，共 14 个回调、约 130 个可点控件。
   隐藏耦合 3 处：`exportInstance` 是死回调、`STAGE_LABEL` 是死常量、`LoaderAvailability` 是死类型导入。
3. **样式是 6 层叠加（3897 行）**：基础层(1–1637) → P26 主题覆盖(1638–2020) → P27 侧栏(2021) → P28 下载面板/进度卡(2154) → P29 玻璃壳+下载中心(2673) → P31 布局与个性化(3636)。
   **143 个 class 被重复定义**，`.ghost` 13 次、`.launch` 13 次、`.app` 10 次、`.stage` 10 次。`:root` 有**两份**，第一份（1–14 行）被第二份（1642–1655）100% 覆盖，是纯死代码。
4. **死样式 30 个 + 整块死组件样式 46 个**：`ModsDialog.tsx` 与 `VersionPicker.tsx` 没有任何文件 import，但它们仍占着 P2 / P3 / P28 约 420 行 CSS。
   另有 6 个 class 反过来「tsx 用了、CSS 没写」：`.muted`、`.settings-row`、`.cf-test-result`、`.stage-name`、`.plugin-btn`、`.is-open`。
5. **自动化验收只剩一个脚本真的碰 DOM**：`cdp-check.mjs`。`p28/p29/p31-check.mjs` 全部跑在 Node/主进程层，**零个渲染层选择器**，改版后它们照样绿——不提供任何 UI 保护。
   真正的第二道闸门藏在 `src/main/index.ts` 的 `--smoke / --smoke-crash / --smoke-settings / --demo` 里，共 60+ 个选择器，任务书里没列但**同样会挂**。
6. **结论**：可以「只改外观」，但必须遵守两条铁律——
   ① **类名 = 测试 API**，17 个 A 级 class、67 项 B 级选择器与 30 余条中文文案一个字都不能动（或保留同名别名）；
   ② **不要在原文件上继续 patch**，而是「同名类、全新声明」整体重写，否则覆盖层会变成第 7 层。

---

## 1. 可见界面盘点

### 1.1 主壳（常驻）

| # | 单元 | 组件文件 | DOM 根 class | 承载功能 | 打开方式 / 驱动 state |
|---|------|----------|--------------|----------|------------------------|
| 1 | 应用根 | `src/renderer/App.tsx` | `.app` | 3 行栅格 `56px / 1fr / 34px`；`::before` 背景图 + `::after` 草地贴图两层伪元素；决定整窗是否溢出 | 常驻（`main.tsx` → `#root`） |
| 2 | 背景吉祥物 | `App.tsx:449` + `MascotImage.tsx` | `.app-companion` | 右下角 230px 水印，`pointer-events:none`、`opacity:.1`，`z-index:0` | 常驻；`fallback={false}` → 图缺失时**什么都不渲染** |
| 3 | 顶栏 | `App.tsx:450-486` | `.titlebar` | 品牌 + 6 个内置动作按钮 + 插件按钮 | 常驻 |
| 3a | 品牌区 | `App.tsx:451-457` | `.brand`（`.brand-fish` / `.brand-mark` / `.brand-sub` / `.brand-version` / `.brand-tag`） | 标题文字（可被设置改）、`v{info.version}`、硬编码 `CubeFish · P40` | `settings.titleText` |
| 3b | 插件按钮 | `components/PluginButtons.tsx` | `.titlebar-actions` 内的 `.ghost.plugin-btn`（无 CSS 规则） | 插件注册的按钮，5 秒轮询 `plugins.buttons()` | 列表为空时返回 `null`（不占位） |
| 4 | 左侧版本栏 | `App.tsx:489-577` | `.version-sidebar`（`.sidebar-head` / `.sidebar-list` / `.sidebar-foot` / `.side-launch`） | 实例列表 + 折叠 + 新建 + 版本管理入口 + **启动按钮** | `leftCollapsed`；`instances` / `instance` / `running` / `taskBusy` |
| 4a | 版本卡 | `App.tsx:505-537` | `.ver-card`（`.ver-icon` / `.ver-card-main` / `.ver-card-name` / `.ver-card-meta` / `.ver-card-tools`） | 点卡片切换实例；📂 打开目录；⋯ 打开版本管理 | `activeIdRef` / `instance.id`；`running` 时禁用切换 |
| 4b | 启动按钮 | `App.tsx:556-573` | `.launch`（`.launch-main` / `.launch-sub` / `.launch-fish`） | 启动 / 运行中 / 处理中三态文案；旁挂 `.ghost.stop-btn` 结束游戏 | `launch()` / `stop()`；`canLaunch` |
| 5 | 中间舞台 | `App.tsx:579-642` | `.stage` | **只剩 3 样东西**：更新横幅、退出诊断卡、插件加载失败提示。`display:flex; align-items:stretch; overflow-y:auto` | 常驻；`update` / `exited` / `info.failedPlugins` |
| 6 | 右侧 AI 侧栏 | `App.tsx:644-657` + `components/ChatPanel.tsx` | `.chat-side`（收起时 `.chat-side-tab`）→ `.chat` | AI 对话；收起后只剩竖排 "AI" 标签 | `rightCollapsed` |
| 7 | 底部状态栏 | `App.tsx:660-673` | `.statusbar`（`.status-dot.status-{update.status}` / `.sep` / `.spacer`） | 更新状态文字、设备号、今日事件、插件数、Electron/Node 版本 | `update` / `info` / `events` |

### 1.2 模态 / 抽屉（7 个）

| # | 单元 | 组件文件 | DOM 根 class | 承载功能 | 打开方式（state / 按钮） |
|---|------|----------|--------------|----------|---------------------------|
| 8 | 下载中心 | `components/DownloadCenter.tsx` | `.overlay` → `.dc`（`.dc-nav` + `.dc-body`） | 游戏安装 / 模组 / 资源包 / 光影 / 整合包 / 下载任务 6 页 | `downloadOpen` + `downloadTab`；顶栏「下载」(`setDownloadTab('game')`)、版本管理「模组」(`setDownloadTab('mod')`) |
| 9 | 版本管理 | `components/VersionManager.tsx` | `.overlay` → `.dialog.dialog-wide.vm-dialog` | 实例表格：切换/改内存/打开 4 类目录/重命名/导出/删除/新建 | `showVersions`；侧栏「⋯」、「版本管理」 |
| 10 | 插件 | `components/PluginsDialog.tsx` | `.overlay` → `.dialog.dialog-wide` | 本地插件（启用/禁用/重载/删除）+ 插件市场（安装） | `showPlugins`；顶栏「插件」 |
| 11 | 设置 | `components/SettingsDialog.tsx` | `.overlay` → `.dialog` | 11 个分组、27 个 patch 字段（含主题色/背景图/标题） | `showSettings`；顶栏「设置」 |
| 12 | 系统 | `components/SystemPanel.tsx` | `.overlay` → `.dialog`（`.system-body`） | 系统信息、麦克风录音、喇叭朗读、源码回滚 | `showSystem`；顶栏「系统」 |
| 13 | 日志 | `components/LogDrawer.tsx` | `.overlay.overlay-right` → `.drawer` | 启动器结构化日志 / 游戏日志（2 秒轮询） | `showLogs`；顶栏「日志」 |
| 14 | 新建实例 | `App.tsx:676-736`（**内联，无独立文件**） | `.overlay` → `.dialog.dialog-narrow` | 输入名称创建 / 粘贴 zip 导入 | `newInstanceOpen`；侧栏「+ 新建」、版本管理「+ 新建版本」 |

### 1.3 常驻浮层 / 内嵌卡片（5 个）

| # | 单元 | 组件文件 | DOM 根 class | 承载功能 | 打开方式（state） |
|---|------|----------|--------------|----------|-------------------|
| 15 | Toast | `App.tsx:675` | `.toast` | 7 秒自动消失的单行提示，**全应用唯一反馈通道** | `toast`（`notify()`），`z-index:60` |
| 16 | 更新横幅 | `App.tsx:580-599` | `.update-banner.update-{status}` | 发现新版本 / 下载中 / 待重启 | `update.status ∈ available\|downloading\|ready` |
| 17 | 退出诊断卡 | `App.tsx:601-635` | `.exit-card`（`.exit-bad` / `.diag-block` / `.diag-summary` / `.diag-suggestions` / `.fix-actions`） | 退出码、崩溃报告路径、诊断建议、一键修复按钮（≤4 个） | `exited` + `diagnosis` + `fixes` |
| 18 | 插件失败提示 | `App.tsx:637-641` | `.warn-box` | 列出加载失败的插件名 | `info.failedPlugins.length > 0` |
| 19 | 进度卡 | `components/ProgressCard.tsx` | `.progress-card`（`.progress-title` / `.progress-pct` / `.progress-bar` / `.progress-facts` / `.progress-stages` / `.task-files`） | PCL 式分阶段 + 逐文件清单 + 取消 | **只在 `.dc-pane` 的 task 页**：`downloadTab === 'task' && progress` |
| 20 | 保留态 | — | — | 无实例时：`.stage` 空、启动按钮文案「没有实例」 | `instances.length === 0` |

### 1.4 大单元内部结构（改版要动的次级块）

| 单元 | 内部块（class） | 数量/说明 |
|------|------------------|-----------|
| 下载中心 `.dc` | `.dc-nav` → `.dc-brand` / `.dc-nav-item`×6 / `.dc-nav-sep` / `.dc-nav-foot`；`.dc-body` → `.dc-head` / `.dc-pane` | 左导航固定 156px，右内容 `min-width:0` |
| 下载中心 · 游戏页 | `.dc-row` / `.dc-label` / `.dc-check` / `.dc-badge` / `.dc-loaders` / `.dc-loader`×4 / `.dc-actions` / `.dc-installed` / `.dc-installed-row` | 4 个加载器卡 |
| 下载中心 · 内容页 | `.dc-pane-split` → `.dc-list-col`（`.dc-search` / `.dc-report` / `.dc-scroll` / `.dc-item` / `.dc-more` / `.dc-installed`）+ `.dc-preview`（`.dc-preview-img` / `-head` / `-desc` / `-meta` / `-thumbs`） | 左右两栏 268px 预览 |
| 下载中心 · 整合包页 | `.dc-row` / `.dc-input` / `.dc-pack` / `.dc-search` / `.dc-scroll` / `.dc-item` | 本地包 + 在线搜索 |
| AI 面板 `.chat` | `.chat-head`（`.chat-session-select` / `＋` / `删` / `.chat-clear`）+ `.chat-list`（`.bubble.bubble-{role}` / `.bubble-streaming` / `.bubble-edit` / `.trace-list` / `.trace-item` / `.bubble-progress` / `.bubble-typing`）+ `.composer-hint` + `.composer`（`input` + 发送/`.composer-stop`）+ `.chat-foot` | 9 个可点控件 |
| 设置 `.dialog` | `.settings-intro` + `.settings-group-title`×11 + `.field` / `.field-inline` / `.field-hint` / `.field-label` / `.pack-row` / `.field-textarea` / `.account-list` / `.account-item` / `.device-code` / `.cf-test-result`（无 CSS） | 11 组、约 35 个控件 |
| 系统 `.system-body` | `<section>`×4 + `<h4>` + `.system-grid` / `.system-row` / `.rec-rows` / `.rec-row` / `.muted`（**无 CSS**） | 4 组 |
| 日志 `.drawer` | `.dialog-head` + `.drawer-actions` + `.kind-tabs`（`.kind-tab`×2）+ `.log-gamebar` + `.log-list`（`.log-row.log-{level}` / `.log-game`） | 抽屉宽 720px，从右侧贴边 |
| 版本管理 `.vm-dialog` | `.vm-table` → `.vm-head` / `.vm-row` / `.vm-name` / `.vm-meta` / `.vm-mem-input` / `.vm-folders` / `.vm-actions` / `.vm-badge` / `.vm-dot` / `.vm-rename` | 6 列表格，行内重命名 |

---

## 2. 功能入口矩阵

### 2.1 App.tsx state（23 个 state + 2 个 ref）

| state | 类型 | 写入点 | 消费者（界面） | 改版检查点 |
|-------|------|--------|----------------|------------|
| `info` | `AppInfo` | 初始化 `window.qdo.info()` | `.brand-version`、`.statusbar`、`failedPlugins` → `.warn-box` | 状态栏 3 个数字不能丢 |
| `settings` | `SettingsShape\|null` | 初始化 + `onSaveSettings` | 标题、`--p31-accent`、`--app-bg`、`DownloadCenter.settings` | `settings` 为空时点「设置」不弹窗（`showSettings && settings`） |
| `instance` | `InstanceSummary\|null` | 初始化 / `switchInstance` / `refreshInstalled` | 侧栏 hero、启动按钮、`DownloadCenter`、`LogDrawer.instanceId` | 无 instance 时下载中心**打不开**（`downloadOpen && instance`） |
| `versions` | `VersionList\|null` | 初始化 `versions.list()` | `DownloadCenter.versions` | 失败只 toast，不阻塞 |
| `installed` | `string[]` | 初始化 / `refreshInstalled` | `DownloadCenter.installedVersions`（✓ 标记、卸载列表） | — |
| `progress` | `TaskProgress\|null` | `onProgress` 事件、`downloadUpdate` 结束清空、6 秒自动收起 | 进度卡、`taskBusy`、导航小绿点 | `taskBusy` 同时禁用启动/新建/切换 |
| `downloadOpen` | `boolean` | 顶栏「下载」、版本管理「模组」 | `DownloadCenter` 挂载 | 关闭方式：overlay 点击 / 「关闭」按钮 |
| `downloadTab` | `'game'\|'mod'\|'resourcepack'\|'shader'\|'modpack'\|'task'` | 「下载」→`game`；「模组」→`mod`；内部 `onTab` | `DownloadCenter.tab` | **改版必测：6 个 tab 都能进** |
| `running` | `{pid?:number}\|null` | `onGameState` running、`launch()`、`onGameState` 退出 | 启动按钮文案/禁用、`.stop-btn`、侧栏切换禁用、「+ 新建」禁用 | 双通道设置 `running`（事件 + 返回值） |
| `exited` | `GameStateEvent\|null` | `onGameState` 非 running、`launch()` 前清空 | `.exit-card` | 崩溃/正常退出两种样式 `.exit-bad` |
| `diagnosis` | `Diagnosis\|null` | 退出后 `diagnose.run()`、`applyFix` 后刷新 | `.diag-block`（`diagnosis.found` 才显示） | — |
| `fixes` | `FixAction[]` | 退出后 `diagnose.fixes()`、`applyFix` 后刷新 | `.fix-actions`（`slice(0,4)`） | 超过 4 个会被截断（既有行为） |
| `fixBusy` | `string\|null` | `applyFix` | 修复按钮 disabled + 「修复中…」 | 防重复点击的唯一措施 |
| `update` | `UpdateState` | 初始化、`checkUpdate`、`downloadUpdate` | `.update-banner`、`.status-dot.status-*`、`updateLabel()` | 7 种状态 → 7 种圆点颜色 |
| `events` | `EventSummary\|null` | 初始化（失败静默） | `.statusbar` 今日事件 | 可缺省 |
| `toast` | `string\|null` | `notify()`（7 秒自清） | `.toast` | **所有失败反馈都走这里，不能删** |
| `showSettings` | `boolean` | 顶栏「设置」/ 保存后关闭 | `SettingsDialog` | 需要 `settings` 非空 |
| `showSystem` | `boolean` | 顶栏「系统」 | `SystemPanel` | — |
| `showLogs` | `boolean` | 顶栏「日志」 | `LogDrawer` | — |
| `showVersions` | `boolean` | 侧栏「⋯」「版本管理」 | `VersionManager` | — |
| `showPlugins` | `boolean` | 顶栏「插件」 | `PluginsDialog` | — |
| `leftCollapsed` | `boolean` | `.sidebar-toggle` | `.main.left-collapsed`（宽度 320→48） | 收起后列表/启动区**整体不渲染** |
| `rightCollapsed` | `boolean` | `.chat-side-collapse` / `.chat-side-tab` | `.main.right-collapsed`（430→46） | 收起后 `ChatPanel` **卸载**（消息 state 丢失，历史从 IPC 重载） |
| `instances` | `InstanceSummary[]` | `refreshInstalled` | 侧栏列表、`VersionManager.instances` | 空数组 → 侧栏空白 |
| `newInstanceOpen` | `boolean` | 「+ 新建」/「+ 新建版本」 | 内联新建实例对话框 | — |
| `newInstanceName` | `string` | 对话框输入 | 创建按钮 disabled 依据 | 创建/导入共用 |
| `importPath` | `string` | 对话框输入 / `dialog.pickFile('zip')` | 导入按钮 disabled 依据 | — |
| `activeIdRef` | ref | 初始化、`switchInstance`、`createInstance`、`delete` | `refreshInstalled` 选活跃实例 | 不触发重渲染（有意） |
| `listening` | ref | 首次挂载 | 防止重复注册 IPC 监听 | **严格模式双挂载保护** |

### 2.2 App.tsx 回调（14 个）

| 回调 | 触发入口 | 走的 IPC | 反馈 | 检查点 |
|------|----------|----------|------|--------|
| `notify` | 全局 | — | `.toast` 7s | 唯一反馈通道 |
| `refreshInstalled` | 初始化、切实例、建/删、保存设置、修复后、进度结束 | `versions.installed()` + `instances.list()` | 失败 toast | 同时刷新 `installed` + `instances` + `instance` |
| `checkUpdate` | 顶栏「检查更新」、初始化（`autoCheckUpdate`） | `update.check()` | 状态栏 + 横幅 | 按钮无 loading 态（只有文字变化） |
| `switchInstance` | `.ver-card` 点击/回车、`VersionManager.onActivate` | `instances.activate()` | toast「已切换」 | `id === activeIdRef` 时直接 return |
| `createInstance` | 新建对话框「创建」 | `instances.create()` → `activate()` | 关窗 + toast | Enter 键也能提交 |
| `importInstance` | 新建对话框「导入」 | `instances.import()` | 关窗 + toast | 名称可留空（用包内名） |
| `openFolder` | `.ver-card` 📂 | `instances.openFolder(id,'game')` | toast | 只开 game 目录 |
| `deleteInstance` | **未被 UI 引用**（版本管理里用自己的 `remove`） | `instances.remove()` | — | **死回调，见 2.5** |
| `exportInstance` | **未被 UI 引用** | `instances.export()` | — | **死回调** |
| `launch` | `.launch` | `launch.start(id)` | toast + `running` | 三重守卫：`running` / `taskBusy` / `instance.installed` |
| `stop` | `.stop-btn` | `launch.stop()` | toast（forced 分支不同文案） | 无确认弹窗 |
| `cancelInstall` | 下载中心「取消」（游戏页/进度卡） | `versions.cancel()` | toast | 两处入口共用 |
| `downloadUpdate` | 更新横幅「下载更新」 | `update.download()` | toast + 状态 | 结束后强制 `setProgress(null)` |
| `applyUpdate` | 更新横幅「重启并更新」 | `update.apply()` | toast | — |
| `onSaveSettings` | 设置「保存」 | `settings.patch(27 字段)` | 关窗 + toast + 刷新实例 | 保存即关窗（无「应用」按钮） |
| `applyFix` | `.fix-actions` 每个按钮 | `diagnose.applyFix()` → 重新 `run`+`fixes` | toast | `fixBusy` 只锁当前按钮 |

### 2.3 子组件 props

| 组件 | props | 来源 | 用途 |
|------|-------|------|------|
| `ChatPanel` | **无 props** | — | 全部状态自持（8 个 state + 4 个 ref） |
| `DownloadCenter` | `instance, tab, onTab, versions, installedVersions, settings, progress, taskBusy, onCancelTask, onClose, onNotify, onRefresh` | App | 12 个 |
| `VersionManager` | `instances, activeId, onClose, onActivate, onRefresh, onNotify, onCreate, onOpenMods` | App | 8 个 |
| `PluginsDialog` | `onClose, onNotify` | App | 2 个 |
| `SettingsDialog` | `settings, onClose, onSave, onNotify` | App | 4 个 |
| `SystemPanel` | `onClose, onNotify` | App | 2 个 |
| `LogDrawer` | `onClose, instanceId?` | App | 2 个 |
| `PluginButtons` | `onNotify` | App | 1 个 |
| `ProgressCard` | `progress, busy, title?, onCancel?` | DownloadCenter | 4 个，只此一处 |
| `MascotImage` | `size?, className?, fallback?, alt?` | App / 内部 | 3 处使用（`.app-companion` / `.brand-fish` / `.launch-fish`） |
| `FishMascot` | `size?, className?` | MascotImage 回退 | 无外部资源 |
| `ModsDialog` | `instance, onClose, onNotify, onRefresh?` | **无人引用** | **死组件** |
| `VersionPicker` | 17 个 props | **无人引用** | **死组件** |

### 2.4 子组件内部交互（改版逐条打勾）

**ChatPanel（9 个控件 + 5 个隐式行为）**

| 控件 | class | 行为 |
|---|---|---|
| 会话下拉 | `.chat-session-select` | `switchSession` → 清屏重载历史 |
| 新建对话 | `.ghost.tiny`（＋） | `newSession`（发送中先 `abort`） |
| 删除对话 | `.ghost.tiny.danger`（删） | `deleteSession` |
| 清空 | `.chat-clear` | `chat.clear` + 回到欢迎语 |
| 补充/修改 | `.bubble-edit` | 回填最后一条用户消息，`replaceMode=true` |
| 发送 | `.composer button[type=submit]` | `chat.send`，空输入禁用 |
| 停止 | `.composer-stop` | 本地立即解禁 + `chat.abort` |
| 过程气泡 | `.bubble-progress` | 最多 8 行 `live`，含计时 |
| 打字气泡 | `.bubble-typing` | 3 个 span 动画 |
| 隐式 | `.composer-hint`（补充模式/发送中/超 90 秒告警） | 三种文案 |
| 隐式 | 自动滚动到底 | `listRef.scrollTop = scrollHeight` |
| 隐式 | 流式增量 | `chat.onDelta`，`sendingRef` 丢弃迟到增量 |
| 隐式 | 朗读 | `system.onSpeak` + `localStorage['qdo:speakReplies']` |

**DownloadCenter（6 页，约 40 个控件）**

| 页 | 控件 |
|---|---|
| 导航 | 5 个 `.dc-nav-item`（游戏/模组/资源包/光影/整合包）+ 下载任务（带 `.dc-nav-dot`） |
| 游戏 | 版本 `select`、含快照 `checkbox`、4 个 `.dc-loader`、加载器版本 `select`、`.dc-actions .primary`（安装）、重新查询、取消、已装版本行（选中/卸载） |
| 模组/资源包/光影 | 搜索框 + 搜索、来源 `select`、检查更新、冲突检查、`.dc-item` 点击预览、`.dc-item-btn` 安装、加载更多、已装项启用/禁用/删除、`.dc-updates` 更新按钮 |
| 整合包 | 路径输入 + 选择文件…/预览/安装 + 在线搜索 |
| 任务 | `ProgressCard` + 取消下载 |

**SettingsDialog（11 组 / 27 个 patch 字段）**

| 分组 | 控件（顺序即视觉顺序） |
|---|---|
| 个性化 | `titleText`、`themeAccent`(color)、`customBackground` + 选择… + 恢复默认 |
| 更新与网络 | `updateFeedUrl`、`autoCheckUpdate` |
| 下载 | `downloadSource`、`downloadThreads` |
| 游戏与启动 | `memoryMb`、`playerName` |
| 启动选项 | `launchWindowWidth`/`Height`、`launchFullscreen`、`jvmArgs`、`isolatedMods` |
| 性能 | `useHighPerformanceGpu`（直接调 `gpu.setEnabled`） |
| Java | radio 列表（`name="java-pref"`）、+ 手动添加 Java、自动选择、下载官方 Java（select 8/16/17/21/25） |
| AI 助手 | `apiKey`、`llmBaseUrl`、`llmModel`、快速切换模型、`confirmDangerousOps`、`allowDangerousAiTools`（有 `window.confirm` 二次确认） |
| 隐私 | `telemetry` |
| 微软账号 | 账号列表（切换/移除）、登录（设备码 `.device-code`）、`msClientId` |
| 内容与市场 | `curseforgeApiKey` + 测试 Key（`.cf-test-result`）、`marketUrl`、`marketPublicKey` |
| 底部 | 取消、保存 |

**其余组件**

| 组件 | 控件 |
|---|---|
| VersionManager | 新建版本、关闭、行内：内存输入、4 个目录链接、切换、模组、重命名（输入 + 保存/取消）、导出、删除 |
| PluginsDialog | 刷新、关闭、`.kind-tab`×2、每行：启用/禁用、重载、删除、市场安装 |
| SystemPanel | 关闭、开始/停止录音、朗读、朗读开关（localStorage）、回滚源码（confirm） |
| LogDrawer | 刷新、关闭、`.kind-tab`×2（启动器/游戏） |
| 新建实例 | 名称输入、路径输入、选择…、取消、导入、创建 |

### 2.5 死代码（定义存在、无人调用）

| 位置 | 内容 | 判定方式 |
|---|---|---|
| `App.tsx:262` | `exportInstance` useCallback | 全文仅 1 次出现（定义） |
| `App.tsx:50` | `STAGE_LABEL` 常量 | 全文仅 1 次出现 |
| `App.tsx:8` | `LoaderAvailability` 类型导入 | 全文仅 1 次出现 |
| `components/ModsDialog.tsx` | 整个文件（375 行） | 无任何 import |
| `components/VersionPicker.tsx` | 整个文件（195 行） | 无任何 import |
| `App.tsx:107` | `activeIdRef` 只在同类内用（正常，但也意味着没有订阅） | — |

---

## 3. 样式分层分析

### 3.1 分层地图（实测行号）

| 层 | 行范围 | 行数 | 规则块(含 @keyframes，近似) | 性质 |
|----|--------|------|------------------------------|------|
| 基础变量 + reset | 1–53 | 53 | 12 | `:root` 第一份 + body/button/code |
| shell | 54–135 | 82 | 12 | `.app` `.titlebar` `.brand*` `.ghost` `.primary` |
| main / stage | 136–300 | 165 | 22 | `.main` `.stage` `.launch` `.steps` `.chip` `.warn-box` |
| chat | 301–472 | 172 | 25 | `.chat*` `.bubble*` `.composer` + 2 个 keyframes |
| statusbar | 473–520 | 48 | 9 | 7 种 `.status-*` |
| overlays | 521–704 | 184 | 26 | `.overlay` `.dialog*` `.field*` `.drawer` `.log*` |
| toast | 705–721 | 17 | 1 | `.toast` |
| P1 | 722–809 | 88 | 9 | `.version-row` `.progress-card` `.exit-card` `.diag-*` |
| P2 | 810–921 | 112 | 11 | 模组市场（现仅 `.dialog-wide` 存活） |
| 滚动条 | 922–941 | 20 | 4 | 全局 `::-webkit-scrollbar` |
| P3 | 942–1065 | 124 | 19 | 已安装/冲突/诊断 + **1060–1064 的「高度微调」补丁块** |
| P4 | 1066–1111 | 46 | 6 | `.trace-*` |
| P5 | 1112–1210 | 99 | 13 | `.plugin-*` |
| P7 | 1211–1254 | 44 | 6 | `.update-*` |
| P8 | 1255–1305 | 51 | 5 | `.instance-select`（死）/ `.kind-tab*` |
| P9 | 1306–1339 | 34 | 2 | `.field-textarea` + `.chat-clear`（**错位：聊天按钮塞在 P9**） |
| P36 | 1340–1406 | 67 | 7 | 会话/打断/补充/`.bubble-progress` |
| P37 | 1407–1476 | 70 | 6 | `.system-*` + `.bubble-streaming` + **`@keyframes blink` 第二份** |
| P13 / P15 | 1477–1500 | 24 | 2 | `.fix-actions` / `.plugin-sandbox` |
| P17 / P18 | 1501–1559 | 59 | 7 | `.account-*` `.device-code` |
| P21 / P22 | 1560–1637 | 78 | 8 | `.pack-*`（多已死）/ `.log-gamebar` `.log-game` |
| **P26 主题覆盖** | 1638–2020 | 383 | 53 | **第二份 `:root`**、顶栏、按钮斜面、草方块启动键、`.dialog`、`.vm-table`、`.settings-*`、状态栏 |
| P27 左侧栏 | 2021–2153 | 133 | 21 | `.version-sidebar` `.ver-card*` `.ver-icon-*` `.sidebar-*` |
| P28 下载面板/进度卡 | 2154–2672 | 519 | 82 | `.dl-*`（现全死）、`.progress-*`、`.mini-chip`（死）、ComfyUI 资源、`.app::before/::after` 第二轮、`.stage` 滚动 |
| P29 玻璃壳 + 下载中心 | 2673–3635 | 963 | 139 | 第三次 `.app` 背景、`.titlebar` 第二版、`.version-sidebar` 第二版、`.ver-hero`（死）、`.quick-*`（死）、`.chat` 第二版、**全部 `.dc-*`**、`.task-file*` |
| P31 布局 + 个性化 | 3636–3894 | 259 | 41 | 第四版 `.main` 栅格、`.side-launch`、`.chat-side` 收起、`.stage` 第四版、`--p31-accent` 接线、`.dc-more` `.vm-mem-input`、min-height 修复 |

**改版判断：这是一份「层层覆盖」的样式表，不是设计系统。**
`base` 里的 `.stage`、`.titlebar`、`.chat`、`.main`、`.launch`、`.dialog` 几乎全部被后面 3–4 段重写，
真正生效的声明散落在 4 个不同行区，读代码时无法从单处判断最终外观。

### 3.2 设计 token

| 变量 | 第一份(1–14) | 第二份(1642–1655)生效值 | 使用次数 | 备注 |
|---|---|---|---|---|
| `--bg` | `#0a0d12` | `#070b10` | 1 | 实际上被 `.app` 背景图盖掉 |
| `--panel` | `#0f141b` | `#0d141c` | 4 | |
| `--panel-2` | `#141c26` | `#121c27` | 1 | 只给 `.bubble-assistant` |
| `--border` | `#1e2a36` | `#1d2c3b` | **38** | 最高频 |
| `--text` | `#e6edf3` | `#e8eef5` | **29** | |
| `--muted` | `#7d8b99` | `#8497a8` | **40** | 最高频 |
| `--accent` | `#4ade80` | `#7ed957` | 9 | MC 草绿 |
| `--accent-2` | `#22c55e` | `#4ea52e` | 1 | 只给 checkbox |
| `--blue` | `#60a5fa` | `#4d6bfe` | 6 | DeepSeek 蓝 |
| `--warn` | `#fbbf24` | `#f0b429` | 7 | |
| `--danger` | `#f87171` | `#ef6f6f` | 3 | |
| `--radius` | `14px` | `10px` | 1 | 只用 1 次（`.steps`，而 `.steps` 已死） |
| `--p31-accent` | **CSS 未定义** | App 注入 `#4d6bfe` | 6 | 用 `color-mix()` 派生 |
| `--app-bg` | **CSS 未定义** | App 注入 `url(file:///...)` | 1 | 路径用 `file:///` 拼，反斜杠已替换 |

**结论**：12 个 token 有 2 份定义（第一份 100% 死）；`--radius` 实际无人使用；
**243 处硬编码颜色**（`#xxxxxx`）绕过 token，是「换个主题色看起来仍不一致」的根因。
真正参与换肤的只有 `--p31-accent`（6 处）+ `--app-bg`（1 处）。

### 3.3 历史补丁互相覆盖（Top 榜）

| class | 定义次数 | 行号 | 性质 |
|---|---|---|---|
| `.ghost` | **13** | 105,115,981,987,1485,1700,1708,1713,2709,2714,2719,3104,3816 | 基础→P3 tiny→P13→P26 斜面→P29 顶栏/下载中心→P31 nav-strong |
| `.launch` | **13** | 185,203,211,215,1736,1748,1756,1760,2580,2669,2910,3703,3875 | 圆角→草方块→stage 内宽→侧栏宽→侧栏紧凑（**5 次尺寸重写**） |
| `.app` | **10** | 55,2528,2533,2543,2554,2559,2677,2681,2691,3805 | 栅格→P28 背景→P29 玻璃→P31 变量背景（`::before/::after` 各 2 份） |
| `.stage` | **10** | 143,1802,2598,2606,2610,2846,2910,3789,3798,3858 | 居中→左对齐可滚动→透明→stretch→min-height 修复 |
| `.is-active` | **9** | 1299,1874,2078,2296,2759,2822,3036,3213,3822 | **7 个 tsx 文件共用同一修饰词**（见 3.4） |
| `.progress-stage` | 9 | 2427…2661 | 网格 4 列，被 P28 二次收紧 |
| `.side-launch` | 9 | 3668,3703,3709,3713,3870,3875,3881,3886,3890 | P31 内连续 4 次微调 |
| `.ver-card` | 9 | 2057,2070,2074,2078,2743,2755,2759,2822,3822 | 纵向卡→横向卡→主题色 |
| `.main` | 8 | 137,2022,3640,3717,3721,3727,3772,3853 | **4 版栅格**：`1fr/430` → `236/1fr/430` → `auto/1fr/auto` |
| `.progress-card` | 7 | 746,2342,2355,2359,2363,2651,3560 | 基础→PCL 大卡→P28 收紧→`.dc` 内去 max-width |
| `.chat-side` | 7 | 3732,3739,3745,3749,3772,3858,3865 | 收起 430→46 |
| `.primary` | 6 | 121,131,917,1718,1727,1731 | 圆角渐变→P2 内边距→P26 斜面 |
| `.chat` | 6 | 302,1802,1807,2960,3739,3865 | 纯色→渐变→玻璃 |
| `.composer` | 6 | 425,432,445,449,458,462 | 无覆盖，唯一稳定块 |
| `.version-row` | 6 | 723,731,742,2140,2144,2149 | **全段已死**（新版用 `.dc-row`） |
| `.dialog-wide` | 2 | 811,1064 | 780px → 800px，第二次在「高度微调」块里，**不在 P2 段内** |

**四个「恶性覆盖」案例（改版必须知道，否则会踩同样的坑）**

1. **`.progress-head` 跨组件串色**
   - `757`（进度卡意图）：`display:flex; justify-content:space-between; font-size:12px; color:var(--muted)`
   - `1377`（聊天意图）：`font-weight:600; color:var(--blue); margin-bottom:2px`
   - `2363`：`.progress-card .progress-head` 只补了布局，**没补颜色** → 进度卡标题现在是蓝色 600 重（聊天补丁泄漏）。
   - 同一个类名被 `ChatPanel`（过程气泡头）和 `ProgressCard`（进度卡头）同时使用，语义不同。

2. **`@keyframes blink` 重名**
   - `401`（打字点：opacity + translateY 弹跳）与 `1473`（流式光标：`to{visibility:hidden}`）同名。
   - 后者覆盖前者 → **打字三点不再弹跳**，只剩闪烁；两处共用同一动画名。

3. **`.dialog-wide` 定义在段外**
   - P2 段 `811` 定 780px，`1060–1064` 的「高度微调」块改成 800px 并同时改死 `.conflict-report`/`.installed-list`/`.mods-list` 的高度。
   - 这段补丁夹在 P3 与 P4 之间，没有段落标题，容易在重构时被误删或误留。

4. **`.stage-hint` 一名两用**
   - `284`：舞台主文案（居中、12.5px、max-width 440）
   - `2446`：`.progress-stage .stage-hint` 覆盖为 11px 单行省略
   - 靠后代选择器隔离；若改版给进度卡换结构（去掉 `.progress-stage` 包裹），`284` 的规则会立刻污染进度行。

### 3.4 被多个组件复用的 class（跨文件 ≥2）

| class | 定义次数 | 使用文件数 | 语义 |
|---|---|---|---|
| `.ghost` | 13 | **12** | 万能次要按钮（含 `.tiny` / `.danger` 修饰） |
| `.tiny` | 5 | 9 | 按钮尺寸修饰（只以 `.ghost.tiny` 组合生效） |
| `.overlay` | 2 | 8 | 遮罩层，所有模态/抽屉共用 |
| `.primary` | 6 | 8 | 主按钮 |
| `.dialog-head` | 4 | 7 | 模态头（`h2` + 右侧按钮组） |
| `.is-active` | 9 | 7 | **9 个组件的选中态共用同一个词**（版本卡 / 加载器 / 导航项 / tab…） |
| `.danger` | 1 | 6 | 只以 `.ghost.tiny.danger:hover` 生效，**按钮本体无危险色** |
| `.dialog` | 2 | 6 | 模态容器 |
| `.field-hint` | 1 | 6 | 说明文字 |
| `.dialog-foot` | 1 | 5 | 模态底部 |
| `.drawer-actions` | 1 | 5 | 头部右侧按钮组（也叫 actions，但和 `.vm-actions` 无关） |
| `.is-ok` / `.is-bad` / `.is-warn` | 6/5/2 | 4/— | 状态修饰，每个组件各自解释 |
| `.kind-tabs` / `.kind-tab` | 1/3 | 3 | 胶囊 tab（日志/插件），下载中心**不用**它而用 `.dc-nav-item` |
| `.field` / `.field-inline` / `.field-label` | 4/1/1 | 3/2/2 | 表单行 |
| `.pack-row` | 2 | 3 | 输入 + 按钮横排 |
| `.warn-box` | 2 | 3 | 错误条 |
| `.composer-stop` | 1 | 2 | **SystemPanel 把「停止录音/回滚」按钮也套了这个类**（红色危险按钮复用聊天停止样式） |
| `.sep` | 2 | 2 | 状态栏 / 进度卡的数字分隔符 |

**风险**：`.is-active` / `.is-ok` / `.danger` / `.chip` 这类「词」没有命名空间，
改版时任何一处调整都会横向影响 4–9 个组件；反之任何一处改名都会漏掉其他组件。

### 3.5 死样式清单

**A. 完全没有任何 `className` 引用（30 个，可整段删除）**

| class | 行号 | 属于 |
|---|---|---|
| `.chat-badge` | 323 | chat |
| `.instances-line` `.instance-name` | 157,165 | main（旧舞台实例行） |
| `.instance-select` | 1256,1268,1781 | P8 多实例下拉（被侧栏取代） |
| `.steps` `.step` `.step-dot` `.step-ok` `.step-pending` `.step-error` `.step-name` `.step-detail` | 232–282 | main（旧步骤清单，被进度卡取代） |
| `.subtle` | 180,1795 | `.chip.subtle` |
| `.mods-installed` | 838 | P2 |
| `.version-row` | 723,731,742,2140,2144,2149 | P1 + 「更紧凑」补丁（**6 次定义全死**） |
| `.ver-card-top` `.ver-card-dot` `.ver-card-info` `.ver-card-actions` | 2083–2124 | P27 旧版纵向卡 |
| `.ver-hero` `.ver-hero-icon` `.ver-hero-main` `.ver-hero-name` `.ver-hero-chips` `.ver-hero-state` | 2852–2908 | P28 旧版舞台 hero（**整块 57 行死**） |
| `.quick-grid` `.quick` `.quick-icon` `.quick-label` `.quick-note` | 2915–2958 | P28 旧版快捷入口（**整块 44 行死**） |

**B. 只被两个已死组件引用（46 个，删组件后可一起删）**

| 组件 | class |
|---|---|
| `ModsDialog.tsx`（24 个） | `.mods-search` `.mods-list` `.mod-row` `.mod-icon` `.mod-info` `.mod-title` `.mod-desc` `.mod-meta` `.mod-compat` `.mini-chip` `.is-incompatible` `.installed-list` `.installed-row` `.installed-name` `.installed-meta` `.is-disabled` `.conflict-report` `.conflict-head` `.conflict-ok` `.conflict-list` `.conflict-item` `.conflict-message` `.conflict-suggestion` `.pack-local` `.pack-preview` `.pack-warn` |
| `VersionPicker.tsx`（22 个） | `.dl-panel` `.dl-panel-head` `.dl-panel-title` `.dl-panel-sub` `.dl-row` `.dl-row-top` `.dl-label` `.dl-select` `.dl-select-narrow` `.dl-check` `.dl-badge` `.dl-hint` `.dl-hint-right` `.dl-warn` `.dl-loaders` `.dl-loader` `.dl-loader-name` `.dl-loader-note` `.dl-foot` `.dl-go` |

> 注意：`.mod-slug` 看着像 ModsDialog 专用，其实 `PluginsDialog` 也在用 → **不能删**。
> 同理 `.dialog-wide` 被 VersionManager / PluginsDialog 使用 → 保留。

**C. 反向：tsx 里用了、CSS 里没有（6 个，属于「漏样式」）**

| class | 使用位置 | 现状 |
|---|---|---|
| `.muted` | SystemPanel 全部次要文字（5 处） | 无规则 → 继承正文色，**次要信息与正文同色** |
| `.settings-row` | SettingsDialog:284（窗口宽高 + 全屏那一行） | 无规则 → 只是普通 div，不横排 |
| `.cf-test-result` | SettingsDialog:639，`.is-ok/.is-warn` 均无效 | 无规则 → 测试结果无颜色；**但 `src/main/index.ts` 会读它的 textContent** |
| `.stage-name` | ProgressCard:150 | 无规则 → 阶段名靠 96px 固定列，无字号/颜色 |
| `.plugin-btn` | PluginButtons:50 | 无规则 → 插件按钮只有 `.ghost` 样式 |
| `.is-open` | DownloadCenter:771（`.dc-preview.is-open`） | 无规则 → 预览栏常驻 268px，不会「打开」 |

**D. 只被测试引用（1 个）**

`.chip`（171,1788 定义）在渲染层**已无任何使用**，但 `src/main/index.ts:578` 会 `querySelectorAll('.chip')` 采集。
删掉不会让 smoke 失败（返回空数组），但会让 `ui.chips` 断言变成 `[]`——**属于「隐性契约」，建议保留类名或同步改 smoke**。

### 3.6 改版判断：必须整体替换 vs 可以保留

**必须整体重写（不要 patch）**

| 目标 | 理由 |
|---|---|
| `.app` + `::before` + `::after` + `.app-companion` | 3 轮背景叠加（2533/2543/2681/2691/3805），且与 `--app-bg` 注入耦合；必须收敛成 1 层背景 + 1 层纹理 |
| `.main` / `.stage` / `.version-sidebar` / `.chat-side` 的栅格与收起 | 4 版栅格 + 3 处 `min-height:0` 补丁（3851 注释自述「网格子项默认 min-height:auto 会把行撑出屏幕」） |
| `.launch` | 13 次定义、5 次尺寸重写，语义在「舞台主角」与「侧栏小按钮」之间反复横跳 |
| `.ghost` / `.primary` | 13 / 6 次定义，含 `inset` 阴影斜面 + 顶栏特例 + 下载中心特例 |
| `.progress-card` / `.progress-*` / `.task-file*` | 7 次覆盖 + `.dc` 内特例；且 `.progress-head` 已被聊天样式污染 |
| 全部 `.dc-*`（60 个 class） | 自成体系、只有 1 个组件用、覆盖次数少（2–4 次），**适合连结构一起重排** |
| `:root` | 删掉 1–14 行那份死定义，只留一份，并把 243 处硬编码颜色逐步收进 token |

**可以基本保留（低风险、单一消费者、无二次覆盖）**

P4 `.trace-*`、P5 `.plugin-*`、P7 `.update-*`、P13 `.fix-actions`、P15 `.plugin-sandbox`、
P17/P18 `.account-*` / `.device-code`、P22 `.log-*`、P37 `.system-*`、P1 `.exit-card` / `.diag-*`、
`.toast`、滚动条、`.composer`（6 次定义但互不冲突）。

**可以删（纯收益）**

30 个完全死样式 + 46 个死组件样式 + 6 处漏样式（补上而不是删）。
合计约 **420 行**，占全文件 10%+，删掉后 `.css` 从 3897 行降到 ~3470 行。

**必须保留类名（但可重写声明）**

见第 4 节 A/B 级清单。原则：**类名是测试与自动化的公开 API，声明是私有实现。**

---

## 4. 自动化测试依赖的选择器

### 4.1 四个脚本的真实覆盖面

| 脚本 | 层级 | 是否碰 DOM | 对 UI 改版的保护力 |
|---|---|---|---|
| `scripts/cdp-check.mjs` | 真机 CDP（真实鼠标/键盘事件） | **是，17 个类名/组合选择器 + 4 条文本断言** | **唯一有效**；改类名必挂 |
| `scripts/p28-check.mjs` | Node（esbuild 临时编译 `Downloader` / `mirrorUrl`） | **否，0 个** | **零**：只验分片/Range/sha1/mirrorUrl |
| `scripts/p29-check.mjs` | Node（临时数据目录 + 真实 content 插件） | **否，0 个** | **零**：验 onFiles 回调、preview、updates、progress 字段 |
| `scripts/p31-check.mjs` | Node（注册表 / Java / junction） | **否，0 个** | **零**：验 GPU 注册表、addManual、mods 目录隔离 |

> 也就是说：**「改版能不能自动化验收」= 「cdp-check.mjs 能不能跑通」**。
> 但 `cdp-check` 只覆盖 AI 面板 + 插件面板，**下载中心、设置、版本管理、系统、日志、状态栏全都没有 DOM 级验收**。
> 这几块的真实保护力来自 `src/main/index.ts` 的 smoke（任务书未列，但必须一起看）。

### 4.2 `cdp-check.mjs` 依赖清单

| 选择器 | 用途 | 断言强度 |
|---|---|---|
| `.composer input` | 挂载探针 / 写入值 / 读 placeholder / 判断 focus | **强**（必须仍是 `<input>`，用 `HTMLInputElement.prototype` setter） |
| `.composer` | `requestSubmit()` | **强**（必须仍是 `<form>` 且有 submit handler） |
| `.chat-list .bubble` | 气泡数量、最后一条文本、`className`（`lastRole`） | **强**（后代关系不能变） |
| `.composer-stop` | 「正在忙」判定 + 真实点击停止 | **强**（存在性即状态机） |
| `.bubble-streaming` | 流式未结束判定 | 强 |
| `.composer-hint` | 读提示文案 | 中（只记录，不断言） |
| `.chat-title` | 与收起按钮做重叠检测（layout 模式） | 中 |
| `.chat-side-collapse` | 同上 | 中 |
| `.trace-item` / `.trace-summary` | 横向溢出检测 | 中 |
| `.chat` / `.chat-head` | `scrollWidth - clientWidth` 溢出检测 | 中 |
| `.titlebar-actions button` | 按文本 `'插件'` 精确匹配点击 | **强**（文本 + 容器） |
| `.plugin-row` / `.plugin-title` / `.plugin-actions button` | 插件行读取 + 按文本 `'删除'` 点击 | **强** |

文本契约：`'插件'`、`'删除'`、placeholder 里的「AI 还在处理…」（读取但不 assert）。

### 4.3 隐藏的第二道闸门：`src/main/index.ts`（smoke / demo）

| 模式 | 启动方式 | 依赖选择器 |
|---|---|---|
| `--smoke` | `npm run smoke`（= `electron . --smoke`） | `.titlebar-actions button`（文本：下载/插件/日志）、`.launch`（`.disabled`+click）、`.launch-main`、`.launch-sub`、`.composer input`、`.composer button`（**取第一个**）、`.dc-nav-item`（文本：模组/资源包/光影/整合包/下载任务）、`.dc-row select`（取 `[0]`/`[1]`）、`.dc-loader`、`.dc-actions .primary`、`.dc-search button`（文本含：检查更新/冲突检查）、`.dc-search input`、`.dc-input`、`.dc-row button`（文本：选择文件…/预览/安装）、`.dc-head .ghost`（文本：关闭）、`.dc-head h2`、`.dc-item`、`.dc-item-title`、`.dc-installed-row`、`.dc-updates .dc-installed-row`、`.dc-report`（+`.is-bad`）、`.dc-preview-img/‑head/‑desc`、`.dc-pack`（`:not(.is-bad)`）、`.progress-title`、`.progress-pct`、`.progress-facts`、`.progress-current code`、`.progress-stage`、`.progress-actions button`、`.task-file`、`.task-files`、`.version-sidebar button`（文本：版本管理 / `+ 新建`）、`.vm-row`、`.vm-row.is-active .vm-name`、`.vm-name`、`.vm-folders button`、`.vm-rename input`、`.vm-rename button`（保存）、`.vm-row button`（重命名/导出）、`.vm-row select`、`.kind-tab`（文本：插件市场/游戏日志）、`.plugin-row`、`.plugin-state`、`.plugins-hint`、`.overlay`（取最后一个再点关闭）、`.dialog-head button`（关闭）、`.dialog .pack-row button`（选择…）、`.dialog .pack-row input`、`.dialog-foot button`（取消）、`.toast`、`.statusbar`、`.chip`、`.trace-item`、`.bubble`、`.fix-actions button`、`.log-row.log-game`、`.log-row.log-error.log-game`、`.log-row.log-game .log-msg`、`.log-gamebar`、`.drawer .drawer-actions button` |
| `--smoke-settings` | `npx electron . --smoke-settings` | `.titlebar-actions button`（设置）、`.dialog-body`（滚动）、`.dialog button`（文本：测试 Key / 含「微软账号」）、`.cf-test-result`、`.account-item`、`.field-label`（含 `client_id` / `CurseForge` / `标题`）、`input[type="color"]`、`.field-inline span`（含「高性能显卡」）、`input[name="java-pref"]` |
| `--smoke-crash` | `npx electron . --smoke-crash` | `.launch`、`.fix-actions button`、`.diag-summary`、`.diag-block`、`.bubble`、`.launch-sub` |
| `--demo` | `npx electron . --demo` | `.titlebar-actions button`（下载/插件/系统）、`.dc-nav-item`（模组）、`.dc-search input`、`.dialog-head button, .dialog button`（关闭）、`.composer input` |

### 4.4 绝不能改名的 class（分级）

**A 级 — 改了 `cdp-check` 直接失败（最高优先级，共 17 个）**

```
.composer          .composer input      .composer-stop    .composer-hint
.chat-list         .bubble              .bubble-streaming .chat
.chat-head         .chat-title          .chat-side-collapse
.trace-item        .trace-summary       .titlebar-actions
.plugin-row        .plugin-title        .plugin-actions
```

**B 级 — 改了 `npm run smoke` 系列失败（共 67 项，含组合选择器）**

```
.launch  .launch-main  .launch-sub
.toast   .statusbar    .chip
.overlay .dialog .dialog-head .dialog-body .dialog-foot .field-label .field-inline
.kind-tab .kind-tabs
.version-sidebar .vm-row .vm-name .vm-rename .vm-folders .vm-actions
.dc .dc-nav-item .dc-head .dc-head h2 .dc-row .dc-row select .dc-row button
.dc-input .dc-search .dc-search button .dc-search input .dc-loader .dc-actions .primary
.dc-item .dc-item-title .dc-installed-row .dc-updates .dc-report .dc-preview-img
.dc-preview-head .dc-preview-desc .dc-pack .dc-head .ghost
.progress-title .progress-pct .progress-facts .progress-current code
.progress-stage .progress-actions button .progress-card
.task-file .task-files
.log-gamebar .log-row .log-game
.drawer .drawer-actions
.plugin-state .plugins-hint
.fix-actions .diag-summary .diag-block
.account-item .cf-test-result
input[type="color"]  input[name="java-pref"]
```

**C 级 — `--demo` 录屏模式依赖（可降级容忍，但会丢演示镜头）**

```
.dc-nav-item  .dc-search input  .dialog-head button  .composer input
```

**文案契约（与类名同等级，全部用「精确匹配」）**

| 位置 | 必须逐字保留的文本 |
|---|---|
| 顶栏 | `下载` `插件` `检查更新` `日志` `设置` `系统` |
| 通用 | `关闭` `取消` `保存` `删除` `重命名` `导出` |
| 版本管理 | `版本管理` `+ 新建` `模组` |
| 下载中心 | `下载任务` `模组` `资源包` `光影` `整合包` `选择文件…`（U+2026） `预览` `安装` `检查更新` `冲突检查` |
| 插件/日志 | `插件市场` `游戏日志` |
| 设置 | `测试 Key`、label 含 `client_id` / `CurseForge` / `标题`、`高性能显卡`、`微软账号` |

> `.dc-nav-item` / `.titlebar-actions button` / `.version-sidebar button` 的匹配是 `textContent.trim() === 'xxx'`。
> **改版时不要加图标字符、不要加空格、不要把「下载」换成「资源下载」。**

### 4.5 替代方案（三选一，推荐 B）

**方案 A：保留旧 class 作别名（改动最小，可立即验收）**

```tsx
// 新结构继续挂旧类名，新样式只挂在额外的新类名上
<aside className="chat-side-panel chat-side">…</aside>
<button className="btn btn-primary primary">…</button>
```
```css
/* 旧类名只留「结构性基线」，不参与新视觉 */
.primary { /* 新视觉写在这里 */ }
```
- 优点：`cdp-check` / smoke 零改动；缺点：类名继续撒谎（`.primary` 不代表新设计）。

**方案 B（推荐）：迁移到 `data-testid`，旧 class 并行保留一个大版本**

1. 在 tsx 里给所有被断言的元素加 `data-testid="chat-composer"` 之类；
2. 新增 `scripts/ui-selectors.mjs` 统一导出选择器映射，把 `cdp-check.mjs` 与 `src/main/index.ts` 改为从映射取；
3. `styles.css` 里为旧类名保留「空声明」（`.composer { }` 加注释）以免 `querySelector` 落空；
4. 下一轮再删旧类名。

示例映射：

```js
// scripts/ui-selectors.mjs
export const SEL = {
  composer: '[data-testid="chat-composer"] input',
  bubbles: '[data-testid="chat-list"] .bubble',   // 过渡期仍用 .bubble
  launch: '[data-testid="launch"]',
  dcNav: '[data-testid="dc-nav"] button',
}
```
- 优点：类名与测试解耦，之后随便改视觉；缺点：要同时改 `src/main/index.ts`（**这是主进程文件，不在「只改外观」的范围内**，需要单独批准）。

**方案 C：直接改测试脚本**
- 只对 `cdp-check.mjs` 可行（渲染层脚本）；
- `src/main/index.ts` 里的 smoke 属于主进程，改它等于改功能代码，**不符合本次「只动外观」的边界**；
- 因此 C 只能作为 A/B 的补充，不能单独使用。

**风险提示（三个具体坑）**

1. `.composer` 必须保持 `<form>` + `.composer input` 必须是 `<input>`：`cdp-check` 用 `HTMLInputElement.prototype` 的 setter 写值，换成 `<textarea>` 会静默失败（`setter.call` 抛错）。
2. `src/main/index.ts:559` 用 `document.querySelector('.composer button')` 取**第一个**按钮当发送键。改版若在输入框左侧加「附件」图标按钮，smoke 会点到附件而不是发送。
3. `.titlebar-actions button` 用精确文本匹配，且 `PluginButtons` 会把插件按钮插进同一个容器。插件名恰好叫「设置」时会误点——这是既有隐患，改版不要放大它（例如把插件按钮挪到独立容器 `.titlebar-plugins` 是**安全**的，因为 smoke 只用 `.titlebar-actions` 找内置按钮；但 `cdp-check` 找「插件」按钮也在这个容器里，挪走内置按钮会挂）。

---

## 5. 改版执行建议（按顺序）

| 步骤 | 动作 | 验收 |
|---|---|---|
| 1 | 先把 A/B 级 class 与文案清单固化成 `scripts/ui-selectors.mjs` + 一份 `docs/ui-contract.md` | 人工 review |
| 2 | 删除死代码：`ModsDialog.tsx`、`VersionPicker.tsx`、`App.tsx` 的 `exportInstance`/`STAGE_LABEL`/`LoaderAvailability` | `npm run typecheck` + `npm run build` |
| 3 | 删死样式：3.5-A（30 个）+ 3.5-B（46 个），补 3.5-C（6 个漏样式） | 目测 + smoke 截图 |
| 4 | 重写 `:root`（只留一份）、把 243 处硬编码色收进 token | 对比截图 |
| 5 | 按 3.6「必须整体重写」逐块替换（建议新文件 `styles.css` 内按 `tokens / layout / components / overlays / states` 分区，**保留同名类**） | `npm run smoke` 全绿 |
| 6 | 起真机跑 `cdp-check` 四个模式 | 见下 |

**验收命令**

```powershell
npm run typecheck
npm run build
npm run smoke                                   # electron . --smoke
npx electron . --smoke-settings
npx electron . --smoke-crash

# AI 面板真机
node scripts/mock-llm.mjs
$env:QDOQMC_LLM_BASE_URL='http://127.0.0.1:18080/v1'; $env:QDOQMC_LLM_KEY='test'
npx electron . --remote-debugging-port=9333
node scripts/cdp-check.mjs 9333
node scripts/cdp-check.mjs 9333 layout
node scripts/cdp-check.mjs 9333 hang
```

> `p28/p29/p31-check.mjs` 可以不跑（它们与 UI 无关），但**不要**因为「它们绿了」就认为改版没问题。

---

## 6. 一句话风险清单（给 review 用）

1. 中间 `.stage` **没有启动按钮**（P31 挪到左侧栏了）——凭旧截图改版会丢主 CTA。
2. `rightCollapsed` 为真时 `ChatPanel` **整个卸载**，消息 state 丢失——不要以为只是「隐藏」。
3. `.toast` 是唯一反馈通道（30+ 处 `notify`）——任何「更优雅的提示」都要先确认这 30 处仍有出口。
4. `--app-bg` / `--p31-accent` 由 `App.tsx` 内联注入，CSS 里没有默认定义——删掉 `var()` 的 fallback 会让自定义背景失效。
5. 背景图在 `build.mjs` 里是硬编码清单 `['mascot-fish.png','tile-grass.png','bg-hero.png','icon-pack.png','bg-user.jpg']`——**新增图片必须同步改 build.mjs**，否则打包后 404（且有 `onError` 兜底，容易看不见）。
6. 无任何 `@media`（实测 0 条）——窗口缩放/小屏适配全靠 flex/grid，改版若引入固定宽度会立刻溢出。

---

## 7. 与既有方案 `docs/UI-REDESIGN.md` 的交叉校验

仓库里已有一份《TCL 风格 · 卡片分页》改版方案（`docs/UI-REDESIGN.md` + `docs/ui-mockup/`）。
本审计不评价其视觉方向，但发现 **8 处与代码事实不符或与自动化冲突**，实施前必须修正：

| # | 方案原文 | 实测事实 | 后果 / 修正 |
|---|---|---|---|
| 1 | §9.6 把 `p28/p29/p31-check.mjs` 列为自动化验收项 | 三者 **0 个 DOM 选择器**，跑在 Node/主进程层 | 它们绿 ≠ UI 没坏；`§9.6` 应改为「仅作回归参考，不构成 UI 验收」 |
| 2 | §6.2 称「`scripts/p28-check.mjs` 等 **4 个 CDP 脚本**」 | 只有 `cdp-check.mjs` 是 CDP，且只覆盖 AI + 插件面板 | 「改选择器」对 p28/29/31 是空操作 |
| 3 | §8.2 注释 `npm run smoke # 窗口能起、无未捕获异常` | `--smoke` 是**全流程 UI 驱动**：点 6 个面板、读 60+ 选择器、截图 10 张 | 严重低估；smoke 是最容易被改版打断的闸门 |
| 4 | §1.2 红线「`src/main/**` 绝不改」，而 smoke 选择器就在 `src/main/index.ts` | 二者互斥：类名一改，**唯一合法的修法被红线禁止** | 因此 §8.4 的「class 别名」**不是可选项，是唯一可行路径**；否则必须开口子允许改 smoke |
| 5 | §7.3「shell 54–135 删除」「main 136–300 删除」 | 这两段里含 `.ghost`(13 次定义/12 文件)、`.primary`(6/8)、`.launch`(13)、`.warn-box`(3) | 整段删除会**删掉全站按钮与主 CTA 的基线**；应拆成「`.app/.titlebar/.brand*` 删，`.ghost/.primary/.launch` 重写保留」 |
| 6 | §7.3「P1–P40 补丁段 722–**3311**」 | 文件实际 **3897 行**，P1 段从 722 起、P31 到 3894 止 | 3311 之后还压着 P28/P29/P31 三大层（含全部 `.dc-*`），漏掉会误判「已清完」 |
| 7 | §6.4「删除 `.mods-*`、`.version-row` 等段落」 | 真正占地方的是**单数** `.mod-*`（`.mod-row/.mod-icon/.mod-info/.mod-title/.mod-desc/.mod-meta/.mod-compat`）与 `.mini-chip/.conflict-*/.installed-*/.pack-local`；而 `.mod-slug` 仍被 `PluginsDialog` 使用 | 按前缀批量删会误伤 `.mod-slug`；精确清单以本报告 3.5-A/B 为准 |
| 8 | §6.2「删除 `ChatPanel` 的收起/展开按钮」 | `cdp-check --layout` 用 `.chat-side-collapse` 与 `.chat-title` 做重叠检测；缺一个只降级为 `overlap:null`，不失败 | 可接受，但会**永久失去「收起按钮压住标题」这项回归保护**；建议保留按钮或改成「隐藏但保留 DOM」 |

**方案里做对了、本审计予以确认的三点**

- §8.4「新组件同时挂旧 class（`<div className="cf-card dialog">`）」——这是唯一能同时满足「红线」与「自动化」的做法，与本文 4.5 方案 A 一致。
- §8.4「AI/下载面板用 `display:none` 而非卸载」——正确，且必须：`rightCollapsed` 今天就是**卸载** `ChatPanel`（见 2.1），改版顺手修掉它是**行为变化**，要单独确认。
- §7.3「chat 段 301–472 保留」——正确，ChatPanel 内部 17 个 A 级选择器全在这段，重写风险最高收益最低。

> 若采用该方案，请把 §7.3 的段落表替换为本文 3.1 的实测表（行号已逐段核对），
> 把 §9.6 的验收项替换为本文 4.4 的 A/B 级清单，并在 S2 之前先落地「class 别名」约定。

---

## 附录：统计口径与可复现性

- 统计脚本：`scripts/_tmp-classcount.mjs`（本次新建，**已删除**）
  - CSS 解析：剥离注释 → 按 `header {` 取选择器 → 提取 `.class` → 记录行号与所属注释段
  - TSX 解析：只取 `className=` / `class=` 属性值（含模板字符串静态段与插值里的字符串字面量），提取 token；以 `xxx-` 结尾的 token 记为「动态前缀」
  - 判定：`used`（有直接引用）/ `shared`（≥2 个 tsx 文件）/ `dead-comp`（只被死组件引用）/ `dynamic`（前缀拼接命中）/ `dead`（无任何 className 引用）/ `test-only`（仅 `src/main/index.ts` 或 `scripts/*.mjs` 引用）
- 原始计数：`548` 条选择器规则、`345` 个 class、`143` 个 class 被重复定义、`25` 个 class 跨组件复用、
  `219` 单文件使用、`24` 动态拼接、`46` 死组件专用、`30` 完全死样式、`1` 仅测试引用、`12` 个 CSS 变量（2 份定义）。
- CSS 特性计数：`!important` 2 处（都在 `.brand-mark` 的 P31 覆盖里）、`@media` **0** 处、`@keyframes` 5 个（`blink` 重名 2 次）、`backdrop-filter` 8 处、`color-mix()` 4 处、硬编码颜色值 243 个、`position: fixed` 7 处、`z-index` 10 处。
- 只读校验：`src/` 下所有文件 mtime 未变；本次仅新增 `docs/_ui-audit.md` 与临时脚本（已删）。
