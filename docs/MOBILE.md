# 方块鱼手机版（Android）方案

> 目标：在 Android 手机上用「方块鱼」启动并运行 **Minecraft: Java Edition**（含模组），并带上方块鱼 AI 助手。
> 状态：M0 进行中（构建链打通）。本文档随进度更新。

## 1. 先说清现实

Minecraft Java 不能直接跑在 Android 上，需要四件套：

1. **ARM 版 OpenJDK**（JRE8 / JRE17 / JRE21 的 Android 移植）
2. **LWJGL / AWT 移植**（Boardwalk 系，让 `java.awt` / `glfw` 能跑）
3. **OpenGL 转发层**（GL4ES / MobileGlues / ANGLE）
4. **SDL 输入层**（触屏/手柄 → GLFW 输入事件）

这是 PojavLauncher / Amethyst 多年的工程。所以方块鱼手机版**不是从零写**，而是：

> 以 [Amethyst-Android](https://github.com/AngelAuraMC/Amethyst-Android)（PojavLauncher 的活跃继任者，LGPL-3.0）为引擎 fork，
> 叠加方块鱼品牌 + 我们自己的 AI 助手模块。

## 2. 架构决策

| 项 | 决定 |
| --- | --- |
| 引擎 | Amethyst-Android `v3_openjdk`（fork，保留 LGPL-3.0 与上游版权） |
| 仓库 | 独立仓库 `CubeFish-Mobile`，桌面版仓库 README 指向它 |
| 引擎目录 | **不改**，只替换品牌资源（应用名 / 图标 / 启动页） |
| AI 模块 | 新增独立包 `…​.ai`（Java/JS，自有版权）：DeepSeek 兼容接口 + 工具注册表 |
| AI 界面 | 复用网页版聊天界面（WebView 加载 `assets/ai/`，JS 负责 LLM 流式循环，工具经 JS↔Java 桥调用引擎能力） |
| ABI | `arm64-v8a` + `armeabi-v7a`（x86 仅模拟器调试时开） |
| 构建 | 本机 Windows + NDK 27.3 可编；CI（Ubuntu，与上游同环境）作为稳定产物渠道 |

## 3. 支持底线（不满足的机型明确不支持）

- CPU：`arm64-v8a` 优先（`armeabi-v7a` 尽力）；x86 只用于模拟器
- 系统：Android 8.0+（引擎 minSdk 仍是 21，但「可玩」按 8.0+ 承诺）
- 内存：≥ 4 GB RAM（建议 6 GB+）
- GPU：OpenGL ES 3.0+（Adreno 6xx / Mali-G 系列以上体验较好）
- 存储：≥ 3 GB 空闲（版本 + 资源 + 模组）

## 4. 里程碑（含验收）

| 里程碑 | 内容 | 验收 | 计划日期 |
| --- | --- | --- | --- |
| **M0** | 打通构建链：SDK 37 / NDK 27.3 / Gradle 9.6.1 / JRE8 产物 → 产出可安装 APK（未改品牌） | `assembleDebug` 成功，APK 内 `lib/` 只有 `arm64-v8a` | 2026-11-08 |
| **M1** | 品牌化：应用名「方块鱼」、图标、启动页；包名后缀 | 真机安装成功；微软账号登录成功；下载并启动 1.21.1 到主菜单 | 2026-11-10 |
| **M2** | AI 助手聊天页（流式、会话、系统提示词与桌面版对齐），上下文可读当前版本/内存/日志摘要 | 真机对话正常；日志摘要经脱敏后才进入上下文 | 2026-11-12 |
| **M3** | AI 工具化：读日志、列/切版本、改内存与 JVM 参数、启动游戏、Modrinth 搜/装模组 | **Fabric 模组包 + Forge 模组包各 1 个：安装 → 启动 → 进主菜单 / 进世界**；不通过则等级降为「原版优先，模组实验性」并写入 README | 2026-11-16 |
| **M4** | 签名 release APK + GitHub Release + 合规声明 | 干净设备安装 release 包并启动成功 | 2026-11-20 |

> 负责人：开发（AI 执行）→ 每个里程碑产出 APK；**真机验收由你（用户）完成**。
> 需要你提供：手机型号、Android 版本、RAM（用于判定走 arm64 还是 armv7，以及验收基线）。

## 5. AI 模块 ↔ 引擎 接口清单（M2/M3 落地）

不魔改引擎源码，只用下面这些「公开面」：

1. **进程内 Java API**：读取 `LauncherProfiles` 里当前选中的版本、内存、JVM 参数（按上游源码实际类名落地，M2 前先 `grep` 确认）。
2. **文件系统**（同一 APK 内可直接读写）：
   - 实例根：`<filesDir>/PojavLauncher/`
   - 游戏日志：`.minecraft/logs/latest.log`
   - 崩溃报告：`.minecraft/crash-reports/`
3. **启动入口**：复用引擎现有的启动 Activity / Intent，不新增启动协议。
4. **若必须新增 IPC**：只加广播或接口层，不修改引擎实现；AI 代码独立包，方便与上游 merge。

## 6. 日志脱敏（M2 硬性要求）

日志/崩溃报告进入 AI 上下文前必须处理：

- 过滤：UUID、绝对路径、邮箱、IP、token/密钥、玩家聊天内容
- 默认**不发送**日志；AI 页提供「允许把日志发给我分析」开关（默认关）
- 发送前在界面展示将发送的摘要（预览）

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| Windows 原生编译失败（ndk-build / 长路径 / SDL） | 走 fork 仓库的 GitHub Actions（与上游 CI 同环境 Ubuntu）产出 APK，本机只做 Java/资源改动 |
| `compileSdk = 37` 属预览 | 已装 `platforms;android-37.0`（channel 3）+ `build-tools;37.0.0`；不行则降 36 |
| JRE 只有 CI 产物（约 90 天过期） | `scripts/fetch-jre.ps1` 按 artifact 名 + 大小 + sha256 校验；失效改用 FCL-Team/Android-OpenJDK-Build 产物 |
| LGPL-3.0 合规 | 保留 LICENSE / 上游版权声明 / 源码可得；release 附源码链接 |
| Minecraft EULA | 不内置任何游戏文件与资源；登录走微软正版设备码（与桌面版一致）；首次启动由用户自己下载版本 |
| 真机网络（微软登录 / 资源下载） | M1 前置验收就包含真机登录 + 下载 1.21.1；不可达时启用镜像（桌面版已在用 BMCLAPI）+ 手动导入版本目录 |
| AI 成本 / 隐私 | Key 存 `EncryptedSharedPreferences`；联网类工具默认关；日志脱敏见第 6 节 |
| 与上游分叉 | 引擎目录零改动，改动集中在品牌资源 + 新增模块，靠 merge 跟进 |

## 8. 明确不做

- iOS（需 Mac + 独立仓库）
- 自研 JRE / LWJGL / 渲染层（不可能在合理工期完成）
- 内置游戏本体或绕过正版验证
