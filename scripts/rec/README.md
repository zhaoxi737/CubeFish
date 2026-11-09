# scripts/rec — 方块鱼宣传片 CDP 录屏管线

用 **CDP（Chrome DevTools Protocol）录 Electron 渲染进程**，不录桌面、不碰用户正在用的启动器。
流程：脱敏演示数据 → 启动 app（独立 userData）→ 缓动鼠标/点击/打字 → screencast 抓帧 →
按帧时间戳重采样成恒定 30fps → H.264 编码，产出 `video/public/rec/<scene>.mp4` + `events.json`。

```
prepare-demo.mjs   从 %APPDATA%\QDOQMC 只读复制脱敏演示数据 → out/demo-data/
cdp-client.mjs     极简 CDP 客户端（Node 原生 fetch + WebSocket，无第三方依赖）
cdp-rec.mjs        screencast 录制器（1600×1000、逐帧 ack、帧时间戳、events/meta）
drive.mjs          场景驱动：启动 app/mock-llm、缓动输入、5 个场景、安全检查
encode.mjs         变帧率 PNG/JPEG 序列 → 时间戳重采样 30fps → ffmpeg 编码 + 抽 review 帧
```

## 一、快速开始

```powershell
# 1) 生成脱敏演示数据（首次约 40~60s、2.0GB；已存在则只重新脱敏 settings）
node scripts/rec/prepare-demo.mjs            # 完整重建加 --force

# 2) 启动 app + mock-llm，录 5 个场景（约 1 分钟）
node scripts/rec/drive.mjs --all
#    单场景：node scripts/rec/drive.mjs --scene=versions
#    复用已开着的 9411：--skip-app      录完保留 app：--keep-app

# 3) 编码 + 抽代表帧（约 30s）
node scripts/rec/encode.mjs --all
```

`drive.mjs` 会**自己启动/关闭** electron（只 kill 自己 spawn 的进程）和 mock-llm。
产物：

| 路径 | 内容 |
|---|---|
| `out/rec/<scene>/frame_*.jpg` | 原始 screencast 帧（JPEG q95） |
| `out/rec/<scene>/events.json` | `[{t,kind:'move'|'click'|'type',x,y,text?}]`（1600×1000 视口 CSS px，t 相对录制开始） |
| `out/rec/<scene>/meta.json` | 时长/帧数/平均 fps/帧时间戳/representative-frame hints |
| `out/rec/<scene>/ui-text.txt` + `safety.json` | 录完时页面可见文字与脱敏扫描结果 |
| `out/rec/<scene>/cfr30/` | 重采样后的 30fps 帧序列 |
| `video/public/rec/<scene>.mp4` | 最终成片（1600×1000 / 30fps / H.264 crf14） |
| `video/public/rec/<scene>.events.json` | 给 Remotion 画设计光标用 |
| `out/rec/review/<scene>_a|b|c.png` | 每个场景 3 张代表帧（轮播/拼贴用） |
| `out/rec/review/home_bright.png` | 确认版主页亮背景帧 |
| `out/rec/summary.json` | 本次录制汇总 |

## 二、演示数据（`prepare-demo.mjs`）

从 `%APPDATA%\QDOQMC` **只读**复制，绝不改源目录：

- 保留：`instances / versions / libraries / runtimes / assets / plugins / plugin-data / settings.json`
- 排除：`cache / Code Cache / GPUCache / DawnGraphiteCache / DawnWebGPUCache / Session Storage / Local Storage / Network / blob_storage / Dictionaries / Shared Dictionary / logs / events / meta / tmp`，以及 `launcher_profiles.json / chat-history.json / chat-sessions.json / identity.json` 等运行时/身份文件（它们不在保留列表里，不会被复制）

`out/demo-data/settings.json` 会被改成：

| 字段 | 值 |
|---|---|
| `playerName` | `方块鱼玩家` |
| `apiKey` | `sk-demo-not-a-real-key` |
| `curseforgeApiKey` | `""` |
| `llmBaseUrl` | `http://127.0.0.1:18080/v1`（mock-llm） |
| `themeAccent` | `#4ade80`（方块鱼品牌绿） |
| `customBackground` | `out/demo-data/assets/brand-bg.png` |
| `activeInstance` | 真实存在的实例目录名（不存在会自动回退） |

实例显示名（只改 `instances/<id>/instance.json` 的 `name` / `playerName`，不动 mods / 存档 / 版本目录）：

- `default` → 创造服
- `inst-mvtojtxn` → 1.21.1 模组服
- `inst-mw72xe8y` → 1.20.1 生存服
- 所有实例 `playerName` → 方块鱼玩家（主页启动按钮下方显示的就是这个字段，不是 settings.playerName）

顶栏不出现「余额」：从 `out/demo-data/plugins/` 删除 `model-balance` 插件副本并清理 `permissions.json`（源目录与 `src/` 不动）。

**背景亮度说明**：`settings.customBackground` 为空时，App 会回退到自带的 `out/renderer/assets/bg-user.jpg`（一张很暗的二次元壁纸），所以不能靠「清空」解决。
现在 `brand-bg.png` 由 App 自带 `bg-hero.png` 用 ffmpeg 提亮 + 加绿生成：

```
scale=1920:1200,eq=brightness=0.34:contrast=1.25:saturation=1.6:gamma=1.45,colorbalance=gm=0.18:gs=0.12
```

另外 App 自带 `.app::before` 是 70%–93% 的黑色渐变遮罩，只靠图片亮度突破不了。录制时 `drive.mjs` 会注入一条只降低该遮罩的样式：

```css
.app::before{background:linear-gradient(180deg, rgba(4,7,11,.32), rgba(4,7,11,.42) 45%, rgba(4,7,11,.55)) !important}
```

它只影响背景遮罩，不改布局/文字/组件；reload 后自动重新注入，只存在于录制期间（不写回 app）。

## 三、录制原理与关键技术

### 3.1 启动 app（脚本自动做）

```powershell
$env:QDOQMC_USER_DATA = "D:\QDOQMC\out\demo-data"
node_modules\electron\dist\electron.exe . `
  --remote-debugging-port=9411 `
  --disable-renderer-backgrounding `
  --disable-backgrounding-occluded-windows
```

`QDOQMC_USER_DATA` 让单实例锁、sessionData、日志目录都落到 `out/demo-data`，不会和用户正在用的方块鱼抢锁；脚本等待 CDP 端口最多 40s，结束时 `taskkill /PID <自己 spawn 的 pid> /T /F`，不碰其他 electron 进程。

### 3.2 固定 1600×1000

`Emulation.setDeviceMetricsOverride` 强制 `1600×1000 / deviceScaleFactor=1 / mobile=false`，与真实窗口大小无关（本机窗口实际 1200×800），保证所有素材尺寸一致。

### 3.3 保活重绘层（解决 1.7fps）

CDP screencast 只在合成器有变化时推帧，静止页面几乎不推帧（实测 0.3fps）。录制前注入一个**不可见的 0.2% 透明动画层**逼合成器持续出帧：

```css
@keyframes cfKeep{0%{opacity:.002}100%{opacity:.003}}
html::after{content:"";position:fixed;inset:0;background:#000;pointer-events:none;
  z-index:2147483647;animation:cfKeep .1s linear infinite}
```

注意：不能把动画 opacity 写成 .998→1（那会成为不透明黑层，录出来全黑）。实测（1600×1000 真实 UI）：

| 方案 | 静止页面 fps |
|---|---|
| PNG q100 + 保活层 | ~9–10 fps（PNG 编码是瓶颈） |
| JPEG q100 + 保活层 | 27.7 fps |
| **JPEG q95 + 保活层（采用）** | **47.3 fps** |
| JPEG q90 + 保活层 | 59.2 fps |
| `Page.captureScreenshot` JPEG q95 紧循环 | 9.0 fps（111ms/帧，不达标） |

最终用 `Page.startScreencast({format:'jpeg', quality:95, maxWidth:1600, maxHeight:1000, everyNthFrame:1})`，每帧立刻 `Page.screencastFrameAck`。最终成片是 H.264 有损编码，q95→q90 的源差异在编码后基本不可见。

### 3.4 输入驱动

全部真实输入事件：`Input.dispatchMouseEvent`（mouseMoved / mousePressed / mouseReleased / mouseWheel）+ `Input.insertText` 逐字输入。
鼠标缓动 ease-out 8~20 步、每步 16ms，不瞬移。每次移动/点击/输入都会 `pushEvent` 写进 `events.json`。

元素定位要求 **可见**：排除 `aria-hidden="true"` 祖先、要求 rect 在视口内。导航后还会断言顶栏激活项（`.cf-nav .is-active` 文案），断言失败直接抛错中止录制，不产出废素材。

### 3.5 五个场景

| 场景 | 动作 | 时长 | 源帧 | avgFps | events |
|---|---|---|---|---|---|
| `home` | 静止 → 缓动到「启动游戏」hover → 「打开游戏目录」hover → 回启动游戏；**不点启动** | 7.82s | 247 | 31.6 | 64 |
| `versions` | 点顶栏「版本」→ 断言版本页 → 3 个实例行缓动 hover → 列表滚动；**不打开新建对话框** | 8.19s | 390 | 47.6 | 69 |
| `download` | 点「下载」→ 键盘选未安装正式版 → 开始安装（真实下载，26.3）→ 等进度 ≥3% → 录 ~4s 进度 → 取消 | 11.46s | 357 | 31.2 | 49 |
| `logs` | 点顶栏「日志」→ 结构化日志抽屉 → 滚 3 次 + 回滚；刚录过 download，日志里有真实安装/取消记录 | 7.17s | 226 | 31.4 | 39 |
| `ai` | 点 `.cf-ai-pill` → 逐字输入「帮我装个钠优化」→ 发送 → 等 mock LLM 工具调用 + 流式回复（最终气泡可见） | 11.87s | 338 | 28.4 | 54 |

版本场景的「新建实例」对话框曾录废过：不是因为点到了 `aria-hidden` 的 `.version-sidebar`（那个容器里的按钮文案是「+ 新建」，脚本按「+ 新建版本」精确匹配、且排除 aria-hidden，点不到），而是因为版本页里那颗**真实的**「+ 新建版本」按钮的 `onCreate` 会 `setPage('home') + setNewInstanceOpen(true)`，而该对话框在 1000px 高的视口里会溢出裁切。现在场景已不再打开它，并在点击后断言 `版本` 页真的激活。

`download` 的 0% 阶段是 App 在解析版本信息/资源索引（可能持续几秒），所以脚本会轮询 `.progress-pct`，等 ≥3% 再录 4 秒并取消，保证 `download.mp4` 里有真实百分比、速度、逐文件列表在动。

### 3.6 代表帧

录制时 `recorder.mark('a'|'b'|'c')` 记录时间点（零成本），`meta.json` 里保存 `hints`；`encode.mjs` 编完后按 hints 从成片里抽 3 张 PNG 到 `out/rec/review/`。比录制中截图便宜，且拿到的是最终画质。

## 四、编码（`encode.mjs`）

CDP screencast 是变帧率的，直接按 30fps 播会快放/慢放。所以：

1. 读 `meta.json` 的每帧时间戳；
2. 按输出帧 i 的 `t=(i+0.5)/30`，取「t 之前最后一帧」（静止段 hold 最后一帧），生成 `cfr30/frame_%06d.<ext>`（硬链接，失败则复制）；
3. 喂给 ffmpeg：

```
ffmpeg -y -framerate 30 -i cfr30/frame_%06d.jpg \
  -c:v libx264 -crf 14 -pix_fmt yuv420p -movflags +faststart -an <scene>.mp4
```

ffmpeg 用 `video/node_modules/ffmpeg-static/ffmpeg.exe`，不额外安装。
输出 `video/public/rec/<scene>.mp4`，并把 `events.json` 复制成 `video/public/rec/<scene>.events.json`。

最终成片（ffmpeg 解码校验）：

| 场景 | 时长 | 编码帧数 | 分辨率/帧率 | 体积 |
|---|---|---|---|---|
| home | 7.800s | 234 | 1600×1000 / 30fps | 0.27 MB |
| versions | 8.200s | 246 | 1600×1000 / 30fps | 0.27 MB |
| download | 11.470s | 344 | 1600×1000 / 30fps | 0.58 MB |
| logs | 7.170s | 215 | 1600×1000 / 30fps | 0.63 MB |
| ai | 11.870s | 356 | 1600×1000 / 30fps | 0.59 MB |

## 五、脱敏自检

`drive.mjs` 每个场景录完会扫描当前页面 `innerText` + 所有 input/select 值，匹配：

- `C:\Users\<用户名>` / 真实 Windows 用户名
- `AppData\Roaming\QDOQMC`（真实数据目录）
- `sk-...` API Key / `api.deepseek.com`
- 其他真实路径片段

结果写 `out/rec/<scene>/safety.json`（命中项会打码），可见文字存 `ui-text.txt`；全部 5 个场景 `hits: []`。
另外人工抽帧检查过：主页/版本/下载/日志/AI 均无真实用户名、真实路径或真实 Key；壁纸、实例名、玩家名已全部换成演示值。

## 六、已知限制 / 注意

- **光标不在 screencast 里**（CDP 只录页面合成结果，不录系统光标）。按原方案由 Remotion 用 `events.json` 画设计光标，所以 events 的坐标/时间要保真。
- `download`、`ai` 两个场景 11~12s，略超 5~9s 计划：download 需要真实进度跑 4~5s 才好看；ai 需要等工具调用 + 流式回复完整出现。
- AI 场景依赖 `scripts/mock-llm.mjs`（端口 18080），`drive.mjs` 会在需要时启动、录完关闭；`settings.json` 的 `llmBaseUrl` 已指向它，不花钱、不碰真 Key。
- 录下载场景会**真实下载**（demo-data 内），脚本在进度跑起来后取消，产物只影响 `out/demo-data/cache` 与演示数据。
- 页面必须保持可见（不要最小化窗口）；`--disable-renderer-backgrounding` 已加，窗口被终端挡住不影响。
- 重跑 `prepare-demo.mjs --force` 会重建演示数据（2GB）；日常重录不用重建，直接跑 `drive.mjs`。
