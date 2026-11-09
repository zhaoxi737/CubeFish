# CubeFish 桌面版 UI 改造方案（TCL 风格 · 卡片分页 · 连续曲率圆角）

> 状态：**方案待确认，尚未动任何源码**
> 基线：`8613153`（已打 tag `ui-baseline-v0.1.0`）
> 目标版本：`0.2.0`
> 核心约束：**只改外观与信息架构，功能一行不减、一行不加、IPC/后端零改动**

参考样张（本方案配套渲染，1400×900，非最终像素）：

- 主页：[home.png](ui-mockup/home.png)
- 下载页：[download.png](ui-mockup/download.png)
- 可交互源文件：[mockup.html](ui-mockup/mockup.html)（浏览器直接打开，点顶栏可切页）

---

## 0. 一句话结论

现在的界面是「P1~P40 十几次补丁叠出来」的工具面板：56px 顶栏塞 8 个按钮、左侧版本栏 + 右侧 AI 栏把中间挤成一条缝、绿色像素风按钮、emoji 图标、4 种强调色混用。改造方向是把外壳换成 **「顶部胶囊导航 + 一页一页的卡片内容」**，圆角统一成 iOS/TCL 那种 **连续曲率（squircle）**，按钮全部变成卡片；所有功能原封不动搬进新外壳。

**风险控制方式：分 6 个可回滚提交点推进，每个提交点都能单独 revert，且 `src/main`、`src/preload`、`src/shared` 三个目录的 diff 必须为空。**

---

## 1. 边界：这次改什么、绝不改什么

### 1.1 改（只在渲染层 `src/renderer/`）

- 布局结构：三栏（版本栏 / 舞台 / AI 栏）→ 顶部导航 + 单页内容
- 视觉系统：颜色、圆角、阴影、间距、字号、图标、动效
- 页面拆分：对话框/抽屉 → 一级页面（下载、版本、AI、设置）
- CSS 架构：`styles.css` 实测 **3897 行 / 548 条规则**（P1~P40 层层覆盖、143 个 class 被重复定义）→ `tokens / base / components` 三层 + 旧样式按页下线

### 1.2 绝不改（本次的红线）

| 类别 | 具体项 | 保障方式 |
|---|---|---|
| 后端 | `src/main/**` 全部 60+ 文件 | `git diff --stat` 必须为空 |
| 桥接 | `src/preload/index.ts`、`src/shared/**` | 同上 |
| 功能 | 每个 `window.qdo.*` 调用点、每个 state 与回调 | 逐条对照 §9 功能矩阵打勾 |
| 数据 | 设置项、实例、账号、下载源、日志、主题色、背景图 | 不新增/不删除任何字段 |
| 文案 | 中文标签保持原意（仅统一大小写/标点） | 每个按钮文案 diff 人工过一遍 |
| 交互语义 | 启动/结束/取消/修复/安装/删除的行为与确认弹窗 | 保留 `window.confirm` 等原逻辑 |
| 打包 | `package.json`、electron 版本、构建脚本入口 | 不改依赖 |

> 唯一允许的「行为变化」是：对话框从「弹窗」变成「页面」，用户少点一次关闭。这是本次需求本身，不算功能变化。
>
> **红线与自动化并不冲突**：`src/main/index.ts` 里的 smoke 脚本按 class + 精确文案驱动界面，所以本次采用「视觉换皮、DOM 契约不动」——旧 class 与文案全部保留，只加新 class 做样式覆盖，详见 **§6.0**。

---

## 2. 现状诊断（为什么现在难看）

对照 [改造前主界面](screenshots/main.png)：

1. **顶栏过载**：56px 里塞了品牌 + 版本号 + `P40` 徽标 + 语音 + 余额 + 下载 + 插件 + 检查更新 + 日志 + 设置 + 系统 = 11 个入口，视觉噪音极大。
2. **三栏挤压**：430px 固定 AI 栏 + 左侧版本栏，中间舞台只剩一条，背景图被裁成竖条。
3. **风格混杂**：`border-radius` 同时存在 4/8/10/12/14px；按钮有「MC 斜面」「草方块渐变」「幽灵描边」三种语言；强调色同时有草绿 `#7ed957`、蓝 `#4d6bfe`，还有警告黄。
4. **图标是 emoji**：📂 ⋯ ▶ ◀ 🎮 ⬇️，跨系统渲染不一致，且和 14px 字重不搭。
5. **CSS 是补丁堆**：P1~P40 每轮在文件末尾追加一段覆盖，同一个 class 被 3~4 处重写，改一处要看 6 个地方。
6. **信息密度失衡**：左侧版本卡 3 行、右侧聊天 5 行气泡，真正的高频操作（启动）被挤在角落，低频操作（检查更新、系统）占据顶栏 C 位。

---

## 3. 视觉基准：把「TCL 那种简洁」翻译成可执行规则

TCL 系（电视/手机系统桌面）的界面语言可以提炼为 8 条，全部落到本方案里：

| # | 规则 | 本方案做法 |
|---|---|---|
| 1 | 一屏只讲一件事 | 每个一级页只放一类内容，下载页不再混入 AI 聊天 |
| 2 | 顶部一条胶囊导航，一眼看到全部入口 | 顶栏正中 4 个 tab（主页/版本/下载/AI 助手），设置类收进右侧图标区 |
| 3 | 大卡片 + 大留白，卡片之间同宽同高节奏 | 12 栏网格，间距 16px，卡片内边距 20–24px |
| 4 | 圆角统一，且是「连续曲率」而非圆弧 | `corner-shape: squircle` + `border-radius`，见 §4.2 |
| 5 | 单一强调色，只给主操作 | 草绿 `#7ed957` 只用于「启动游戏」「安装」「当前 tab」三处 |
| 6 | 背景近黑、层次靠明度差而非描边 | `#08090b` → `#101216` → `#16191e` 三档，描边仅 7% 白 |
| 7 | 线性图标、统一 1.5px 描边、20px 网格 | 内置 SVG 图标集（约 18 个），去掉全部 emoji |
| 8 | 动效短、只做位移与透明度 | 160–220ms，`cubic-bezier(0.22, 1, 0.36, 1)`，无弹跳、无旋转 |

---

## 4. 设计 token（最终写进 `src/renderer/ui/tokens.css`）

### 4.1 颜色

```
--bg        #0a0e13   窗口底（不用纯黑）
--surface   #101216   一级卡片
--surface-2 #16191e   卡片内嵌块 / 输入框
--surface-3 #1c2027   选中态 / 标签底
--hairline  rgba(255,255,255,0.07)
--hairline-strong rgba(255,255,255,0.12)
--text      #eceef1
--text-dim  #8b929c
--text-faint #5f666f
--accent    #4ade80   品牌绿（仅主操作，占屏面积 ≤10%）
--accent-soft rgba(74,222,128,0.12)
--accent-ink #0a1607  绿底上的字
--info      #4d6bfe   分类色（低饱和）
--warn      #f0a03c
--danger    #f0716d
```

底色上叠一层极淡光晕，避免纯黑发死：

```css
background:
  radial-gradient(120% 80% at 50% 0%, rgba(90,130,180,0.10), transparent 60%),
  var(--bg);
```

兼容 P31 个性化：`--accent` 不写死，改为 `--accent: var(--p31-accent, #4ade80)`，设置里的主题色继续生效；背景图继续挂在 `.app` 的 background 层，只是上面加一层 `rgba(8,9,11,.86)` 蒙版保证可读性。

### 4.2 圆角：真的贝塞尔连续曲率

已实测（用本仓库的 Electron 43.3.0 起了一个隐藏窗口跑 `CSS.supports`）：

```
Electron 43.3.0 · Chromium 150.0.7871.212 · Node 24.18.1
CSS.supports('corner-shape','squircle')      → true
CSS.supports('corner-shape','superellipse(1.6)') → true
```

也就是说 **不需要任何 polyfill、不需要 SVG mask**，直接用原生 CSS（Chrome 139 起稳定，我们是 150）：

```css
.cf-card {
  border-radius: 20px;                    /* 角落占多大：≈ 高度 × 0.22 */
  corner-shape: superellipse(1.6);        /* 弯成什么形状：1=正圆，1.6=苹果式 squircle */
  background: linear-gradient(180deg, rgba(255,255,255,.055), rgba(255,255,255,.02));
  border: 1px solid rgba(255,255,255,.07);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.10), 0 8px 24px rgba(0,0,0,.35);
}
@supports not (corner-shape: superellipse(1.6)) {
  .cf-card { border-radius: 16px; }       /* 老内核兜底：普通圆角，布局不变 */
}
```

- 逐级：`--r-sm 10px`（标签/胶囊）、`--r-md 14px`（按钮/输入框）、`--r-lg 20px`（卡片）、`--r-xl 26px`（主视觉卡/启动按钮）。
- 曲线强度：`superellipse(1.4~1.8)` 是甜点区间（默认 **1.6**）；小控件 1.2–1.4；图标底板 2（更「方」）；999px 胶囊保持 `round`，加超椭圆会把两端压平。
- **必须同时给非 0 的 `border-radius`**，否则 `corner-shape` 不生效；边框/描边/阴影会跟随新形状裁切（Chromium 内部用三次贝塞尔逼近，开销与普通圆角同级）。
- `corner-shape` 变化会触发重绘，**不要拿它做动画**；带封面的卡片要实测 `overflow` 四角是否裁干净。
- 兜底方案（仅当以后内核回退）：`clip-path: path()` 超椭圆，会裁掉外阴影、且要 `ResizeObserver` 重算路径，**不作为首选**。

### 4.3 尺寸与排版

```
间距：8 的倍数（8 / 12 / 16 / 20 / 24 / 32）；组内 12，组间 16，页边距 24
字号（字号/行高/字重）：
  页面标题 26/34/600    实例名 30/38/700    数字 17/24/700（tabular-nums）
  卡片标题 16/24/600    正文 14/22/400      次要 12/18/400      辅助 11
导航：高 48，容器 padding 4，圆角 999，激活胶囊 rgba(255,255,255,.10)
列表行：高 44–52；卡片内边距 20；中文最小 12px
字体：
  "MiSans VF","MiSans","Segoe UI Variable Text","Segoe UI",
  "Microsoft YaHei UI","Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif
  font-synthesis: none;        /* 防伪粗体 */
  中文 letter-spacing 0；11–12px 英文标签 0.02em
滚动条：6px、圆角、rgba(255,255,255,.14)
```

### 4.4 阴影与层级

- 卡片常规：无阴影，靠 1px 描边 + 明度差。
- 卡片 hover：`translateY(-1px)` + 描边提到 12% 白，160ms。
- 浮层（顶栏、对话框）：`0 20px 50px rgba(0,0,0,.45)`。
- 主按钮：`0 14px 34px rgba(90,200,60,.18)` + 顶部 1px 内高光。
- 全屏禁用 `backdrop-filter`，只在顶栏与 toast 用一次，避免 GPU 掉帧。

### 4.5 动效

```
--ease: cubic-bezier(0.2, 0, 0, 1)      /* TCL 常用：起步快、收尾稳 */
时长：120–240ms，全局不超过 260ms
```

tab 指示器（只动 transform，保证 120fps）：

```css
.tab-indicator {
  position: absolute; top: 4px; height: 32px;
  border-radius: 999px; background: rgba(255,255,255,.10);
  transform: translate3d(var(--x), 0, 0);
  transition: transform 240ms cubic-bezier(.2,0,0,1);
  will-change: transform;
}
.tab-strip { contain: layout paint; }
@media (prefers-reduced-motion: reduce) { .tab-indicator { transition-duration: 1ms; } }
```

- 只动 `transform`（必要时 + `opacity`），不动 `left/top/width/margin`。
- 移动层上不要挂 `backdrop-filter`、阴影动画或 `corner-shape` 动画。
- 页面切换：新页 `opacity 0→1` + `translateY(6px)`，180ms；卡片按压 `scale(.995)` 90ms。
- 尊重系统「减少动态效果」。

---

## 5. 信息架构：三个页面 + 一条 AI 侧边栏

```
┌──────────────────────────────────────────────────────────────────────────┐
│ 鱼 方块鱼  │  主页   版本   下载  │   ●已是最新  ≡ ⬡ ⚙  LX            │ 64px
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│                    当 前 页 面（大部分是留白）          [✦ AI 助手] ← 悬浮 │
│                                                                          │
├──────────────────────────────────────────────────────────────────────────┤
│ 离线模式 · 设备 8e04bd5d · 今日事件 582 · 插件 29 · Electron 43.3.0      │ 30px
└──────────────────────────────────────────────────────────────────────────┘
```

### 5.1 一级页面（3 个 tab）+ AI 侧边栏 + 右侧工具区

| 位置 | 承载的原功能 | 原入口 |
|---|---|---|
| **主页（极简）** | 只放三样：当前实例名（+ 一行版本信息）、`打开游戏目录`、`查看日志`、`启动游戏`（运行时变「结束游戏」）。其余全部留白 | 原左侧栏 + 舞台里的高频部分 |
| **版本** | 实例列表、新建、导入、导出、删除、切换、打开目录、版本管理 | 原左侧版本栏 + `VersionManager` 弹窗 |
| **下载** | 游戏版本安装、模组、资源包、光影、整合包、已安装管理、冲突检查、下载任务、进度卡 | 原 `DownloadCenter` 全屏对话框 |
| **AI 侧边栏** | 聊天、多会话、打断、补充、工具轨迹、语音输入、余额。右边缘「✦ AI 助手」胶囊悬浮，点开滑出 420px 抽屉，点 ✕ 或再点外面收起 | 原右侧 430px 常驻栏 |
| 右侧工具区 | 日志、插件、系统、设置、检查更新（图标按钮 + 视觉隐藏文案） | 原顶栏 6 个按钮 |

> **AI 不做一级页面**：既满足「主页要空」，又让 `ChatPanel` 继续待在原来的 `.chat-side` 结构里 —— DOM 契约零变化，是风险最低的做法。
> 设置相关入口（设置/插件/系统/日志）收进顶栏右侧图标区，点开仍是**整页**；内部 tab 切换。
> 图标按钮保留可被测试读到的文案：`<button><svg/><span class="cf-sr">日志</span></button>`，`textContent` 仍精确等于「日志」，见 §6.0。

### 5.1.1 顶栏的三段结构

```
[品牌 34px logo + 方块鱼 + 版本]   [胶囊 nav：主页 / 版本 / 下载]   [●状态 图标×5 头像]
```

- nav 容器：`padding:4px; gap:4px; border-radius:999px; background:rgba(255,255,255,.04)`，激活项 `rgba(255,255,255,.10)` + 600 字重，**不用品牌色整块填充**（TCL 的做法）。
- 右侧 5 个图标按钮：40×40、圆角 13（squircle 1.4）、线性图标 1.5px、hover 才显底色；`title` 给中文提示。
- 状态胶囊「已是最新 / 检查更新中」不可点；检查更新是独立图标按钮。

### 5.2 主页线框（对应 [home.png](ui-mockup/home.png) 与 [home-ai.png](ui-mockup/home-ai.png)）

```
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   当前实例                                                      │
│   的吧                                                          │
│   1.21.1 · Fabric 0.16.9 · 4096 MB                              │
│                                                                │
│   [▤ 打开游戏目录]   [≡ 查看日志]   [▶ 启动游戏]      (✦ AI 助手)│ ← 悬浮在右侧
│   回车直接启动                          ↑ 起 72px 高、绿底白字    │
│                                                                │
│                        … 其余全部留白 …                         │
└────────────────────────────────────────────────────────────────┘
```

- 实例名是**可点的**：点它跳到「版本」页去切换实例（不额外加按钮，不破坏留白）。
- 只在有内容时才出现的三条状态：更新横幅（顶部细条）、崩溃诊断条（按钮行下方，含一键修复）、插件失败提示（顶部黄条）。没有就不占位。
- 「运行中」时启动按钮变「结束游戏」，右侧小字显示 PID 与已运行时长（沿用原文案逻辑）。
- AI 抽屉从右滑出，宽度 420px，覆盖在页面上（不挤压主页），对话记录在收起后保留（`display:none`，不卸载）。
- 抽屉顶部保留**原有的会话管理**：`之前的对话（N）` 下拉切换、`＋ 新建`、`删除`、`清空`（就是现在 AI 面板那一排，一个不少）。
- 主题色 / 背景图 / 标题文本仍在「设置」页（P31 个性化），`--p31-accent` 与 `--app-bg` 照常接线。

### 5.3 下载页线框（对应 [download.png](ui-mockup/download.png)）

```
下载  按当前实例过滤                    [游戏][模组][资源包][光影][整合包]
┌ 搜索框 ─────────────────────────────┐ ┌ 来源▾ ┐ ┌ 加载器▾ ┐ ┌ 冲突检查 ┐
┌ 结果列表（8/12）─────────────────────────┐ ┌ 下载任务卡（4/12）────────┐
│ 图标 名称 + 标签 / 描述 / 版本 chip / 安装 │ │ 进度条 + 速度 + 剩余      │
│ ...                                      │ ┌ 预览卡（4/12）────────────┐
│ [加载更多 · 已安装 25 个]                 │ │ 图标 / 说明 / 依赖        │
└──────────────────────────────────────────┘ └───────────────────────────┘
```

### 5.4 关键状态怎么摆（不能丢）

| 状态 | 新位置 |
|---|---|
| 更新可用横幅 | 主页顶部一条细卡片（仅在有更新时出现）；仍是「下载更新 / 重启并更新」 |
| 游戏退出 + 崩溃诊断 | 主页按钮行下方展开一条诊断条（仅出现一次），一键修复按钮全部保留 |
| 安装 / 下载进度 | **只在下载页**（原样保留 `ProgressCard` 与逐文件清单）；主页不显示 |
| 运行中 | 启动按钮变「结束游戏」，副行显示 PID / 时长 |
| Toast | 右上角浮层，位置不变 |
| 插件加载失败警告 | 主页顶部小黄条 |
| 首次无版本 | 启动按钮变「先去下载」，点了跳下载页（文案沿用原逻辑） |
| 切换实例 | 点主页实例名 → 版本页（原左侧栏的切换能力不丢） |

---

## 6. 组件与文件改造清单

### 6.0 硬前提：DOM 契约不能破（这是「功能没丢」的机器证明）

`npm run smoke`（4 个模式：`--smoke` / `--smoke-settings` / `--smoke-crash` / `--demo`）和 `scripts/cdp-check.mjs` 都是靠「class + 精确文案」驱动真实界面的：

- `src/main/index.ts`（主进程，**不在这次改动范围**）里有约 70 个选择器：`.titlebar-actions button`（按文案 下载/插件/检查更新/日志/设置/系统）、`.launch`、`.dc-*`、`.vm-*`、`.kind-tab`、`.progress-*`、`.dialog-head button`（关闭）、`.overlay`、`.toast`、`.statusbar`、`.chip` 等。
- `scripts/cdp-check.mjs` 有 17 个关键选择器：`.composer`（必须是 `<form>`）、`.composer input`（必须是 `<input>`）、`.chat-list .bubble`、`.chat-side-collapse`、`.titlebar-actions button`（文案「插件」）、`.plugin-row` 等。
- 文案是**逐字精确匹配**：`textContent.trim() === '下载'`，加图标字符、加空格、把「下载」改成「资源下载」都会直接失败。

所以这次改版的工程定调是：**视觉换皮，DOM 契约不动**。

| 做法 | 说明 |
|---|---|
| 旧 class 全保留 | 新视觉只挂新 class（`cf-*`），旧 class 继续留在同一元素上，样式覆盖而非替换 |
| 文案逐字保留 | 下载 / 插件 / 检查更新 / 日志 / 设置 / 系统 / 关闭 / 取消 / 保存 / 删除 / 重命名 / 导出 / 版本管理 / 游戏日志 / 插件市场 / 选择文件… / 检查更新 / 冲突检查 |
| 图标按钮带隐藏文案 | `<button><svg/><span class="cf-sr">日志</span></button>`，`textContent` 仍精确等于「日志」，用户只看到图标 |
| 「对话框 → 页面」不删 DOM | 把 `.overlay`/`.dialog` 从 `position:fixed` 改成文档流容器，层级、按钮、关闭逻辑原样保留 |
| `.composer` 保持 `<form>` | 发送键仍是 `.composer button` 里**第一个**按钮，输入框左侧不许加新按钮（否则 smoke 会点错） |
| 不碰 `src/main/index.ts` | 改 smoke 脚本 = 改主进程 = 越界；宁可让 CSS 兼容也不动它 |

**结论：改版完成后 `npm run smoke` + `cdp-check.mjs` 一条命令全绿 = 功能没丢的硬证据；任何一步变红就回滚到上一个 tag。**

风险从「可能漏功能」降级为「可能没对上契约」，而契约是可以在提交前一条命令自测的。

### 6.1 新增文件（全部新目录，便于整体回滚）

| 文件 | 作用 |
|---|---|
| `src/renderer/ui/tokens.css` | 颜色/圆角/间距/字体/动效变量 |
| `src/renderer/ui/base.css` | reset、排版、滚动条、选中色 |
| `src/renderer/ui/components.css` | `.cf-card` `.cf-btn` `.cf-nav` `.cf-field` `.cf-tag` `.cf-list-row` `.cf-sheet` `.cf-toast` |
| `src/renderer/ui/AppShell.tsx` | 顶栏 + 页面容器 + 底部状态栏（纯展示，接 props/children） |
| `src/renderer/ui/NavTabs.tsx` | 胶囊 tab + 滑动指示器 |
| `src/renderer/ui/Card.tsx`、`Button.tsx`、`Field.tsx`、`Icon.tsx` | 原子组件（薄封装，不带业务） |
| `src/renderer/pages/HomePage.tsx` | 主页（极简：实例名 + 三个按钮；从 App.tsx 拆出渲染，不改逻辑） |
| `src/renderer/pages/VersionsPage.tsx` | 版本页（包一层 VersionManager 现有逻辑） |
| `src/renderer/ui/AiSidebar.tsx` | AI 抽屉外壳：`.chat-side` 容器 + 右边缘胶囊 + 滑入滑出，内部仍是 ChatPanel |
| `src/renderer/pages/SettingsPage.tsx` | 设置/插件/系统/日志 四 tab 容器（各子组件原样嵌入） |

### 6.2 修改文件（改动性质均为「换外壳」）

| 文件 | 改法 | 风险 |
|---|---|---|
| `App.tsx` | 只做三件事：① 引入 AppShell 作为外壳（顶栏 nav 3 项 + AI 抽屉 + 状态栏）；② 把 `downloadOpen` 换成 `page` 状态，`showSettings/showPlugins/showSystem/showLogs` 改成整页；③ 原有所有 state/回调/JSX 片段整块搬进 `pages/*`，逻辑行不重写 | 中（唯一大文件，需逐块对照） |
| `components/SettingsDialog.tsx` 等 6 个弹窗 | 外壳 `.overlay > .dialog` 换成 `<PageShell>`；内部字段、按钮、逻辑一行不动 | 低（结构化包裹） |
| `components/DownloadCenter.tsx` | 去掉 `.overlay` 与 420px 侧栏高度约束，改成页面栅格；内部 5 个 tab 逻辑不动 | 中（文件 41KB，需分段改） |
| `components/ChatPanel.tsx` | 容器宽度自适应；**收起/展开按钮保留 DOM**（`.chat-side-collapse` 只做视觉隐藏），否则 `cdp-check --layout` 会永久失去「收起按钮压住标题」这项回归保护 | 低 |
| `styles.css` | 顶部 `@import` 新三层；旧规则按页逐段删除（实测行号清单见 §7.3） | 中（删之前先 `git grep` 引用） |
| `index.html` | 引入字体栈（不下载字体，仅 font-family）、给 `.app` 加背景层 | 极低 |
| `scripts/build.mjs` | 若 CSS 用 `@import` 则无需改；若拆多文件则加 `cp` | 极低 |
| `scripts/cdp-check.mjs` | 只在「class 别名保不住」时才改；它是唯一碰 DOM 的自动化脚本 | 低 |

### 6.3 明确不动的文件

`src/main/**`（60+ 文件）、`src/preload/**`、`src/shared/**`、`package.json`、`out/**`、`dist/**`、`assets` 美术资源。

### 6.4 已确认的死代码（本次顺手删，先确认无引用）

- 组件：`components/ModsDialog.tsx`（375 行）、`components/VersionPicker.tsx`（195 行）——全仓库无 import。
- `App.tsx` 内：`exportInstance`、`STAGE_LABEL`、`LoaderAvailability`（类型导入）无人使用。
- 完全死样式 30 个：`.steps/.step*`、`.version-row`、`.instance-select`、`.instances-line/.instance-name`、`.chip.subtle`、`.chat-badge`、`.mods-installed`、`.ver-card-top|dot|info|actions`、`.ver-hero*`、`.quick*`。
- 仅被上述两个死组件引用的 46 个：`.mod-*`（单数）、`.dl-*`、`.conflict-*`、`.installed-*`、`.mini-chip`、`.pack-local|preview|warn`。

> 坑：**不要按前缀批量删**——`.mod-slug` 仍被 `PluginsDialog` 使用，`.dialog-wide` 仍被 `PluginsDialog/VersionManager` 使用。
> 另发现 6 个「用了但没样式」的类：`.muted`（SystemPanel 全部次要文字）、`.settings-row`、`.cf-test-result`（smoke 会读它的 textContent）、`.stage-name`、`.plugin-btn`、`.is-open`，S1 一并补上。

> 删死文件单独一个 commit，便于 revert。

---

## 7. 实施：6 个可回滚提交点

### S0 · 安全网（本次已完成 + 剩余 10 分钟）

已完成：

- tag `ui-baseline-v0.1.0` 指向 `8613153`
- 源码备份 `D:\QDOQMC-backup\ui-baseline-20261109-1944.zip`（renderer/preload/shared/build.mjs/package.json）

待做（实施前 1 分钟）：

```bash
git checkout -b ui/clean-shell      # 从 8613153 拉分支，master 保持干净
```

### S1 · 设计层落地（0.5 天）

- 新增 `ui/tokens.css`、`ui/base.css`、`ui/components.css`、`ui/Icon.tsx`
- `styles.css` 顶部 `@import` 三个新文件（新层优先级最高，旧规则暂留）
- 不改任何 JSX → 页面结构还是旧的，只是颜色/圆角/按钮/滚动条全部换成新语言
- 验收：`npm run typecheck` + 启动截图，确认没有布局塌陷
- commit：`feat(ui): 设计 token 与基础组件样式（S1）` → tag `ui-s1`

### S2 · 外壳与主页（1 天）

- 新增 `ui/AppShell.tsx`、`ui/NavTabs.tsx`、`pages/HomePage.tsx`
- `App.tsx` 换成新外壳：顶栏导航 + 主页卡片；原来的 5 个弹窗入口先挂到右侧图标区，**弹窗仍是弹窗，功能立刻可用**
- 验收：主页 12 项功能逐条点（启动/结束/打开目录/切版本/更新/诊断修复/日志/设置/插件/系统/下载入口/AI 入口）
- commit：`feat(ui): 顶部导航外壳 + 主页卡片（S2）` → tag `ui-s2`

### S3 · 版本页 + 下载页（1.5 天）

- `pages/VersionsPage.tsx`：左侧栏功能全部搬入列表卡片（新建/导入/导出/删除/切换/打开目录）
- `pages/DownloadPage.tsx`：`DownloadCenter` 的 overlay 外壳换成页面栅格；5 个 tab、搜索、加载更多、已安装、冲突检查、逐文件进度全部保留
- 验收：装一个空实例 → 选 1.21.1 → 安装完成 → 查模组 → 装一个模组 → 取消一次安装
- commit：`feat(ui): 版本页与下载页（S3）` → tag `ui-s3`

### S4 · AI 页 + 设置页（1 天）

- `pages/AssistantPage.tsx`：`ChatPanel` 原样嵌入整页；**必须常驻挂载**（用 CSS 隐藏而不是卸载），否则切页会丢对话
- `pages/SettingsPage.tsx`：设置 / 插件 / 系统 / 日志 四个子组件放进同一页的 tab，原组件内部不动
- 验收：连续对话 3 轮 → 切到主页 → 切回来消息还在；设置改动保存生效；插件启停；日志实时滚动
- commit：`feat(ui): AI 页与设置页（S4）` → tag `ui-s4`

### S5 · 清场与验收（0.5 天）

- 删除旧 `.titlebar/.version-sidebar/.chat-side/.dc-*` 等已被替换的 CSS 段（先 `git grep` 校验）
- 删除死组件 `ModsDialog.tsx`、`VersionPicker.tsx`
- 更新 CDP 脚本选择器（若做了 class 别名则本步为空）
- 重新生成 `docs/screenshots/*.png` 三张，更新 README
- 全量验收：§9 矩阵 + `npm run typecheck` + `npm run smoke` + `npm run build` + `npm run package`
- commit：`chore(ui): 清理旧样式与死代码（S5）` → tag `ui-s5`；合并回 master 打 `v0.2.0`

总工期：约 **4 个工作日**（不含你确认方案的时间）。

### 7.3 旧 CSS 段落下线顺序（S5 清单，行号已按实测核对）

`styles.css` 实际 **3897 行 / 548 条规则 / 345 个 class（其中 143 个被重复定义）**，`@media` 0 处，硬编码颜色 243 处。替换后按下表处理（删除前必须 `git grep` 该 class 的 JSX 引用）：

| 段落 | 实测行范围 | 处理 |
|---|---|---|
| 基础变量 + reset | 1–53 | 保留但重写（`:root` 第一份 100% 被 1642 覆盖，只留一份新 token） |
| shell：`.app/.titlebar/.brand*` | 54–135 | 删除（被 AppShell 取代）；**同段里的 `.ghost` `.primary` 要重写保留**，全站按钮在用 |
| main / stage：`.main/.stage/.chip/.warn-box` | 136–300 | 删除（被 HomePage 取代）；**`.launch*` 是主 CTA，重写保留** |
| chat | 301–472 | **保留**（ChatPanel 的 17 个 A 级选择器全在这段，重写风险最高收益最低） |
| statusbar | 473–520 | 改成新状态栏（保留 `.statusbar` 类名与 `.status-*` 语义） |
| overlays / dialog / field / drawer / log | 521–704 | 保留作为 `PageShell` 壳样式，S5 再收窄 |
| toast | 705–721 | 保留（`.toast` 是 smoke 断言） |
| P1–P9 | 722–1339 | 逐段对照：`.progress-*` `.exit-card` `.diag-*` `.trace-*` `.plugin-*` `.kind-tab` 保留；`.version-row` `.steps` `.instance-select` 等死样式删 |
| P36 / P37 | 1340–1500 | 保留（会话/打断/系统/`.fix-actions`） |
| P17–P26 | 1501–2020 | 保留 `.account-*/.log-game*`；P26 的「第二份 :root + 斜面按钮 + 草方块启动键」整体作废重写 |
| P27 左侧栏 | 2021–2153 | `.version-sidebar/.ver-card*` 保留类名，样式重写为版本页卡片 |
| P28 下载面板/进度卡 | 2154–2672 | `.dl-*` 全死→删；`.progress-*` 重写；`.app::before/::after` 第二轮删 |
| P29 玻璃壳 + 下载中心 | 2673–3635 | `.ver-hero*` `.quick*` 死→删；**全部 `.dc-*` 与 `.task-file*` 保留类名、样式重写** |
| P31 布局 + 个性化 | 3636–3897 | `.main` 第四版删；`--p31-accent` / `--app-bg` 接线**必须保留**；`.chat-side` 收起逻辑保留 |

---

## 8. 版本管理与回滚（本次的硬要求）

### 8.1 分支策略

```
master                 ← 不动，随时可发版
└── ui/clean-shell     ← 全部改版提交在这里
    ├── S1 tag ui-s1
    ├── S2 tag ui-s2
    ├── S3 tag ui-s3
    ├── S4 tag ui-s4
    └── S5 tag ui-s5 → 合并 master → v0.2.0
```

### 8.2 每步验收脚本（不通过不允许进下一步）

```bash
npm run typecheck                # 类型零错误
npm run build                    # 打包成功
npm run smoke                    # 全流程 UI 驱动：点开 6 个面板、读 60+ 选择器、截图 10 张
git diff --stat master -- src/main src/preload src/shared   # 必须为空
```

> `npm run smoke` 不是「窗口能起」的冒烟，而是**真点界面**：下载中心选版本→装加载器→真下载→取消→版本管理重命名→插件/设置/日志/系统逐页读取。
> 它是这次改版最容易被打断的闸门，也是「功能没丢」的主要机器证明。
> 另外三个 Node 级检查（`p28/p29/p31-check.mjs`）**0 个 DOM 选择器**，只验后端逻辑，跑绿不代表 UI 没坏，列在验收里仅作回归参考。

### 8.3 一键回滚

```bash
# 回到改造前
git checkout ui-baseline-v0.1.0 -- src/renderer scripts/build.mjs

# 回到某个提交点
git reset --hard ui-s2

# 完全没救时：解压备份
# D:\QDOQMC-backup\ui-baseline-20261109-1944.zip
```

### 8.4 保护「功能不丢」的工程手段

1. **class 别名兼容**：新组件同时挂旧 class（`<div className="cf-card dialog">`），旧 CSS 与 CDP 测试选择器继续命中，S5 之后再决定是否清理。
2. **props 不变**：所有 `components/*.tsx` 的 props 签名不改，只改根节点 JSX。
3. **状态不许搬家**：`App.tsx` 里所有 `useState/useCallback` 原样保留在原文件（或整块移动并保持依赖数组不变）。
4. **面板常驻**：AI、下载这类带内部状态的面板，页面切换用 `display:none` 而非卸载。
5. **逐页改**：一次只动一个页面，改完立刻手点验收，再进下一个。

---

## 9. 验收矩阵（改版后逐条打勾）

### 9.1 主页（9 项，极简版）

- [ ] 显示当前实例名 + 一行版本信息（版本 / 加载器 / 内存）
- [ ] 点实例名 → 跳到版本页
- [ ] 打开游戏目录
- [ ] 查看日志（打开日志页）
- [ ] 启动游戏（含「未安装版本」时禁用 + 提示；「先去下载」跳下载页）
- [ ] 结束游戏（运行中出现，显示 PID / 时长）
- [ ] 更新横幅：下载更新 → 重启并更新（仅在有更新时出现）
- [ ] 崩溃诊断条 + 一键修复（仅在退出/崩溃后出现）
- [ ] 右侧「✦ AI 助手」胶囊 → 抽屉滑出、能发消息、✕ 收起后对话记录还在

### 9.2 版本页（8 项）

- [ ] 实例列表 / 当前实例高亮
- [ ] 新建实例（名称 + 从 zip 导入）
- [ ] 导出实例（另存为 + 文件数提示）
- [ ] 删除实例（确认弹窗文案不变）
- [ ] 切换实例
- [ ] 打开目录
- [ ] 版本管理（安装版本 / 加载器可用性）
- [ ] 无实例空态

### 9.3 下载页（12 项）

- [ ] 游戏版本列表 + 已安装标记 + 安装
- [ ] 安装进度（阶段/百分比/速度）+ 取消
- [ ] 模组搜索（Modrinth）+ 分页加载
- [ ] 模组安装 + 依赖提示 + 冲突检查
- [ ] 资源包 / 光影 / 整合包 tab
- [ ] 已安装列表：启用/禁用/删除
- [ ] 逐文件进度清单
- [ ] 下载源选择提示（自动/官方/镜像）
- [ ] 整合包本机安装
- [ ] 预览面板
- [ ] 磁盘占用 / 版本隔离提示（如有）
- [ ] 任务队列与速度显示

### 9.4 AI 侧边栏（9 项）

- [ ] 发送消息 / 流式回复
- [ ] 停止生成 / 补充输入
- [ ] 多会话切换 / 新建 / 删除 / 清空
- [ ] 工具调用轨迹（成功/失败标记）
- [ ] 语音输入
- [ ] 余额显示
- [ ] 安装模组类工具的实际落地（进度事件）
- [ ] 收起重开后消息还在（不再卸载 ChatPanel）
- [ ] 输入框回车发送、Shift+Enter 换行

### 9.5 设置 / 插件 / 系统 / 日志（8 项）

- [ ] 设置：主题色、背景图、标题文本、自动检查更新、下载源、内存、启动选项、性能开关
- [ ] 设置保存后立即生效（标题/主题色/背景）
- [ ] 插件：列表、启停、失败原因、删除
- [ ] 系统：麦克风/喇叭/系统信息
- [ ] 日志：实时滚动、按级别过滤、复制
- [ ] 新建实例弹窗
- [ ] Toast 提示
- [ ] 窗口最小化/关闭行为不变

### 9.6 自动化验收（只有这两条真正保护 UI）

- [ ] `npm run smoke` 通过 —— **全流程 UI 驱动**：下载中心选版本→装加载器→真下载→取消→版本管理重命名→插件/设置/日志/系统逐页读取，60+ 选择器 + 精确文案
- [ ] `node scripts/cdp-check.mjs` 通过（真实鼠标键盘：发消息→回复→还能输入→停止→插件删除 + layout 重叠检测）
- [ ] 四个模式全跑：`--smoke` / `--smoke-settings` / `--smoke-crash` / `--demo`
- [ ] CDP 截图 3 张：主页 / 下载 / AI，人工比对样张
- [ ] `git diff --stat master -- src/main src/preload src/shared` 为空
- [ ] （回归参考，不算 UI 验收）`p28/p29/p31-check.mjs` 仍绿 —— 这三个跑在 Node/主进程层，**0 个 DOM 选择器**

---

## 10. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| CSS 层叠打架（旧规则覆盖新层） | 高 | 局部错位 | 新层 `@import` 放最前 + 新 class 前缀 `cf-`；S5 集中删旧段 |
| smoke 因 class/文案契约失配变红 | 中 | 无法自动验收 | §6.0 契约清单；S1 先落地「旧 class 别名 + sr-only 文案」，每步先跑 smoke |
| `corner-shape` 在打包版不生效 | 低 | 圆角变普通圆角 | 已实测 Chromium 150 支持；`@supports` 兜底，降级无害 |
| 主题色/背景图功能被新 token 覆盖 | 中 | P31 设置失效 | `--accent: var(--p31-accent, …)`，背景层保留 |
| 切页导致 AI 对话/搜索状态丢失 | 高 | 体验倒退 | 面板常驻挂载（display 切换） |
| 少量窗口尺寸下栅格溢出 | 中 | 内容被裁 | 页面主体 `overflow:auto`，最小窗口 1024×680 |
| CDP 测试脚本因 class 改名失效 | 中 | 无法自动验收 | class 别名 + 保留旧选择器 |
| 改动 App.tsx 时误删某个功能块 | 中 | 功能丢失 | 逐块搬迁 + §9 矩阵人工点检 + 每步 tag |
| 字体在老旧 Win10 上回退难看 | 低 | 轻微 | 系统字体栈，无需内置字体 |

---

## 11. 交付物

1. 本次方案：`docs/UI-REDESIGN.md`（本文件）
2. 视觉样张：`docs/ui-mockup/home.png`（极简主页）、`docs/ui-mockup/home-ai.png`（AI 抽屉打开）、`docs/ui-mockup/download.png`、可交互 `mockup.html`
3. 渲染层契约审计：`docs/_ui-audit.md`（A/B 级不可改名 class、死代码、文案契约）
4. 改版代码：分支 `ui/clean-shell`，5 个 tag（`ui-s1`…`ui-s5`）
5. 回滚包：`D:\QDOQMC-backup\ui-baseline-20261109-1944.zip` + tag `ui-baseline-v0.1.0`
6. 新截图与 README 更新（S5 产出）

---

## 12. 需要你确认的 2 件事

1. **AI 抽屉的默认状态**：默认收起、点右侧「✦ AI 助手」滑出（推荐，保持主页留白）；还是默认展开 420px？
2. **强调色**：继续用草绿 `#4ade80`（品牌一致），还是换更中性的薄荷白/蓝？

> 不回复就按默认走：AI 默认收起、草绿强调色。

另有一个既有 bug 需要你同意才修（修了算行为变化）：现在点「收起 AI 助手」会把整个聊天组件**卸载**，再展开时对话记录丢失；改版可以顺手改成「隐藏但保留 DOM」，对话不丢。默认**不修**，等你确认。
