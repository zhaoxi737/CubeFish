# CubeFish / 方块鱼 · 宣传片（Remotion）

**1920×1080 横屏 / 30fps / 1824 帧（60.8s，150 BPM）**。全片逐帧代码渲染，没有任何照片轮播。主入口：`Promo1920x1080`。

S0–S5 已全部实现；旧的竖屏 `Promo1080x1920` 保留，不再交付。

## 分段

| 段 | 帧 | 内容 |
| --- | --- | --- |
| S0 | 0–143 | 像素鱼飞入拼合 + 光晕 + 左右分栏标题 + 字幕 |
| S1 | 144–479 | 真录屏 3 段：主页 / 版本管理 / 安装游戏；光标、点击涟漪、描边高亮 |
| S2 | 480–575 | 压缩包 → 拉链开 → 文件飞出 → CubeFish.exe |
| S3 | 576–959 | 四张功能卡依次入场，字幕联动高亮 |
| S4 | 960–1535 | 五段 AI：工具调用、读日志、写插件、记忆/并行、语音 |
| S5 | 1536–1823 | 三张界面卡 3D 飞入 → 收拢 → 像素鱼落版 + 信息条 |

## 渲染

```powershell
cd D:\QDOQMC\video
npm install
```

### 全片（1824 帧，带音轨）

```powershell
npx remotion render Promo1920x1080 out/cubefish-promo-1080p.mp4 --crf=16 --image-format=png
```

或 `npm run render:full`。

### 分段

```powershell
npm run render:s0     # 0–143
npm run render:s1     # 144–479
npm run render:s2     # 480–575
npm run render:s3     # 576–959
npm run render:s4     # 960–1535
npm run render:s5     # 1536–1823
```

### 关键帧自检（12 张）

```powershell
node scripts/render-key-stills.mjs
```

输出 `out/keyframe_0000.png`、`0070`、`0143`、`0200`、`0300`、`0420`、`0540`、`0700`、`0900`、`1100`、`1400`、`1700`。

### 预览

```powershell
npm run studio
```

打开终端提示的地址，选择 **`Promo1920x1080`**。

## 版式

- 画布 1920×1080，左右安全区 120px，主内容 1680×900
- 字幕：底边距 90px，40px 粗体白，圆角 18px，内边距 18×36，居中，单条 ≥45 帧
- 背景：`#0e1611` + 48px 白 4% 网格 + 暗角 + 绿色粒子

### S0（0–143）

鱼组中心 `x=740, y=510`，30px 方块；右侧文案左起 x=1080、组中心 y=580，标题 140px，4px `#26561B` 右下描边。字幕底边距 90px。

### S1（144–479，112×3）

- 卡片 1400×800，中心 (960,425)（top=25），24px 圆角、1px 白 10% 边框、外发光
- 录屏层 `filter: brightness(1.16) contrast(1.10) saturate(1.12)`，不叠黑色 veil
- home 段：源左上区域 ×1.25 裁切放大，让实例名/按钮/启动占满卡片；versions/download 全幅
- 卡片入场：`rotateX 6°→0`、`rotateY -8°→0`、`scale .92→1`、opacity，spring(14, .7)
- 段间 6 帧交叉淡入；光标来自 `*.events.json`，按卡片裁切/缩放重新映射；点击 3 圈绿色涟漪
- 高亮框：1.5px `#4ADE80` 透明描边、12px 圆角
- 字幕：150–250「一个实例，一套存档、模组、配置」/ 254–352「版本、加载器，随时切换」/ 356–478「选好加载器，点一下它自己下、自己装」
- 音效：144 whoosh .15，每次 click click.wav .15

### S2（480–575）

zip 图标中心 x=680，`scale .75→1` + `translateY 60→0`；7 个文件沿弧线飞到 x=1160；56–76 帧合并为 CubeFish.exe（中心 x=1300，22px 圆角、顶部高光、底部投影）；72–96 浮动 + glow 呼吸。字幕「一个压缩包，双击就跑」。

### S3（576–959）

4 张 380×460 卡，间距 40，中心 y=500；24px 圆角、白 4% 底、白 8% 边、内发光。local 0–150 依次入场（延迟 0/36/72/108），卡顶 12 列像素 wipe。入场后固定不动，第 576/672/768/864 帧对应卡高亮（1.5px `#4ADE80`），其余卡 opacity .62 + scale .97。字幕四条各 96 帧。

### S4（960–1535，120×4 + 96）

五段均以「裁切录屏 + 代码叠加层」构成：

1. AI 工具调用：聊天抽屉放大，蓝色用户气泡 + `→ 调用 search_mods` 工具卡
2. 日志归因：红框错误行（1.5px `#ff5c5c` + 10% 淡底，无 glow）+ 右侧「定位：Iris 旧版本残留」
3. 写插件：代码面板打字，结束时绿色小方块飞向顶栏
4. 记忆/并行：3 层分支树，节点 8px + 连线 #4ADE80
5. 语音：底部 5 根声波竖条按 `sin(frame*.4+i)` 抖动

段间 8 帧、8 列像素 wipe；字幕 964/1084/1204/1324/1444 起；音效 riser .18、转场 whoosh .12、打字每 3 帧 type .10。

### S5（1536–1823）

三张 520×325 截图卡从左右/下方飞入（x=420/960/1500，y=470），1620 帧向中心收拢淡出；像素鱼 logo 从 0.3 弹入 + 光晕；1700 帧标题「方块鱼」上浮，底部 70px 信息条 + 1764 帧 GitHub 行；最后 20 帧整体 1→1.02。音效 hit .30、sparkle .20。

## 字体

- `public/fonts/msyh-regular.ttf` / `msyh-bold.ttf` 由 `C:\Windows\Fonts\msyh*.ttc` 用 fontTools 提取
- `src/fonts.ts` 用 `@remotion/fonts` 的 `loadFont()` 加载，内部 `delayRender()`
- 字体栈保留 `Microsoft YaHei` 兜底；重新生成：`scripts/extract-fonts.ps1`

## 浏览器

`remotion.config.ts` 指定本机 Edge：

```ts
Config.setBrowserExecutable(
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
);
```

换机器时改路径，或删掉后 `npx remotion browser ensure`。

## 工程结构

```
video/src/
├─ Root.tsx / PromoLandscape.tsx   # 主入口 1920×1080
├─ landscape/
│  ├─ layout.ts                    # 安全区 / 段落表
│  ├─ S0Landscape.tsx … S5Landscape.tsx
│  ├─ fishLandscape.ts / recEvents.ts / FeatureIcon.tsx
├─ components/                     # Backdrop / CaptionBar / FishVoxel / MiniFish / ParticleField
├─ FishGrid.ts / theme.ts / fonts.ts / lib/random.ts
video/public/
├─ rec/                            # 由录屏管线交付，只读
├─ review/                         # S5 用的三张截图
├─ audio/                          # BGM / SFX，由音频环节交付，只读
└─ fonts/
video/scripts/                     # 字体、鱼网格、still 抽取脚本
```

## 约束

- 所有动画是 `frame` 纯函数，无 `Math.random()` / `Date.now()`；随机来自整数哈希
- 所有 `interpolate()` 带 `extrapolateLeft/Right: 'clamp'`
- 品牌色只在 `src/theme.ts`：`#5CB045 / #9CDD6E / #3A7F2B / #141F0D / #26561B / #4ADE80 / #0e1611 / #8A9A8E / #F2F7F2`

## 已知取舍

- S1 三条字幕按画面重新对齐（home / versions / download），不再沿用旧的附录文本顺序
- S4 日志段把录屏冻结在 5.0s 的帧上，保证红框错误行和「定位」标签始终对齐；动态只来自叠加层
- S4 的「用户气泡 / 代码 / 树 / 声波」是代码叠加层，不依赖录屏里是否有对应元素
- S5 的 logo 用 `MiniFish` 平铺绘制（无 112 块独立动画），但落版观感与 S0 一致
- keyframe 1700 是标题 spring 的第 0 帧，标题刚起步；完整标题在 1720 之后更明显
