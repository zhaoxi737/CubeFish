# P31 后端实现记录

## 改动文件

| 文件 | 改动 |
| --- | --- |
| `src/shared/types.ts` | `SettingsShape` 新增 11 个字段；`JavaRuntimeInfo` 新增 `preferred?: boolean` |
| `src/main/plugins/settings.ts` | `DEFAULT_SETTINGS` 新增字段 + `sanitize` 类型/范围校验 |
| `src/main/plugins/java.ts` | `addManual` / `setPreferred`；`detect()` 第 5 来源 manual；preferred 排序与 `select()` 优先 |
| `src/main/plugins/gpu.ts` | 新插件：Windows 用户级 GPU 偏好注册表 |
| `src/main/kernel.ts` | 注册 `createGpuPlugin()`（java 之后、instances 之前） |
| `src/main/plugins/launch.ts` | 窗口参数、jvmArgs 切分、spawn 前 `gpu.apply` |
| `src/main/plugins/instances.ts` | `contentDir` / `rebindContentDirs`（junction） |
| `src/main/plugins/content.ts` | 所有内容落盘路径改走 `contentDir`/`destForRel` |
| `src/main/plugins/ipc.ts` | 新 IPC 处理器 + settingsPatch 触发 rebind |
| `src/shared/channels.ts` | 新通道名 |
| `src/shared/api.ts` | `java` 扩展 + `gpu` 命名空间 |
| `src/preload/index.ts` | `java.addManual/setPreferred` + `gpu.setEnabled/status` |
| `scripts/p31-check.mjs` | 新增验收脚本 |
| `docs/P31-NOTES.md` | 本文件 |

## 新增字段（全部可回退，不破坏旧调用）

`isolatedMods`(bool, 默认 true)、`useHighPerformanceGpu`(bool, 默认 false)、
`preferredJavaPath`(string, 默认 '')、`manualJavaPaths`(string[], 默认 [])、
`launchWindowWidth/Height`(number, 默认 0)、`launchFullscreen`(bool, 默认 false)、
`jvmArgs`(string, 默认 '')、`themeAccent`(string, 默认 '#4d6bfe')、
`customBackground`(string, 默认 '')、`titleText`(string, 默认 '')。

sanitize 校验：width/height 钳到 0..16384；accent 只收 `#hex`(3-8 位) 或纯字母色名，否则回退默认；
路径类 trim；`manualJavaPaths` 数组去重（大小写不敏感）。

## 新增 IPC / preload 调用签名

- `window.qdo.java.addManual(path: string): Promise<JavaRuntimeInfo>`
- `window.qdo.java.setPreferred(path: string): Promise<{ ok: boolean }>`
- `window.qdo.gpu.setEnabled(enabled: boolean): Promise<{ ok: boolean; applied: number; message?: string }>`
- `window.qdo.gpu.status(): Promise<{ enabled: boolean; entries: number }>`

通道名：`java:add-manual` / `java:set-preferred` / `gpu:set` / `gpu:status`。

## p31-check 实测结果

环境：Windows，本机探测到 3 个 Java 21（Microsoft jdk-21.0.11.10-hotspot 等）。

### a) GPU 高性能显卡偏好
- `gpu.setEnabled(true)` → `{ ok: true, applied: 6 }`（3×java.exe + 3×javaw.exe）。
- `reg query HKCU\Software\Microsoft\DirectX\UserGpuPreferences` 能看到 `GpuPreference=2;` ✓。
- `gpu.status()` → `{ enabled: true, entries: 13 }`（`entries >= 1` 通过）。
- `gpu.setEnabled(false)` → 注册表变为 `GpuPreference=0;` ✓；`status()` → `{ enabled: false, entries: 7 }`。

> 注意：`UserGpuPreferences` 是系统级共享键。`status().entries` 按 spec 解析整个 key 里
> `GpuPreference=2` 的条数，会包含**其它应用**已写入的条目（本机原本就有 7 条 =2）。
> 启用后 6+7=13，关闭后剩 7。`enabled` 字段才是开关状态（读 settings）。若 UI 想要「仅本启动器
> 生效的条数」，需要后端额外记录自己写过的 exe 路径再过滤，当前实现按 spec 字面量走，未额外记录。

### b) 手动 Java 管理
- `java.addManual('C:\Program Files\Microsoft\jdk-21.0.11.10-hotspot\bin\java.exe')`
  → `{ major: 21, source: 'manual' }`（major > 0 ✓）。
- `detect(true)` 出现 `source: 'manual'`（1 条）✓。

### c) 内容目录版本隔离（junction）
- `isolatedMods=true`：`contentDir('default','mods')` = `<gameDir>/mods`，`lstat` 为**真实目录**（非 symlink）✓。
- 切 `isolatedMods=false` + `rebindContentDirs()`：`contentDir('default','mods')` 路径仍是 `<gameDir>/mods`，
  但 `lstat` 为 **junction/symlink**，`realpathSync` 指向 `<data>/shared/mods` ✓。

## 偏离 / 说明

1. **GPU `setEnabled` 会持久化 `settings.useHighPerformanceGpu`**：这样 `status().enabled` 与设置一致，
   launch 也读同一设置。UI 若要开关高性能显卡，直接调 `gpu.setEnabled(bool)` 即可（不必再单独 patch 设置）。
2. **`GpuService` 额外暴露了 `apply(exePath)`**（spec 里说「你决定」）：launch 在 spawn 前只对该 java.exe
   写偏好，带 5 秒节流，避免每次启动全量扫写。未在 IPC/preload 暴露给前端。
3. **`modpacks` 不隔离**：`kindDir('modpack')` 返回 'modpacks' 时仍走 `gameDir/modpacks`，不建 junction。
4. **手动 Java 来源标签会覆盖同名自动发现项**：manual 是第 5 个候选来源；若该路径也被 PATH/常见目录发现，
   会以 `source:'manual'` 呈现（显式意图优先），否则去重会吞掉 manual 标签、无法满足「detect 出现 manual」。
5. **关闭 GPU 写 `GpuPreference=0` 而非删值**（按 spec），因此 p31-check 会在本机 HKCU 留下 6 条 =0 条目
   （无害，等于「让系统决定」），未做删除清理。
6. 内容目录的 junction 为**惰性创建**（首次 `contentDir`/安装内容时）或 `rebindContentDirs()`（开关切换）时创建；
   未在 instances 启动时主动全量建，避免启动额外开销。

## 验证命令

- `npx tsc --noEmit` → exit 0（含 renderer 全量）。
- `npm run build` → exit 0。
- `node scripts/p31-check.mjs` → exit 0（上方结果）。
