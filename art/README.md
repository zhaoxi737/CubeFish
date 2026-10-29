# QDOQMC 美术资源说明（art/）

本目录的四张 PNG 全部由**本机部署的 ComfyUI**（绘世整合包）出图后用整合包自带 Python + Pillow 做后处理，无新增依赖。
`src/` 未改动，未执行 `npm run build` / `npm run package`。

## 环境与启动方式

| 项目 | 值 |
| --- | --- |
| 整合包 | `D:\ai comfy ui\ComfyUI-aki(2)\ComfyUI-aki-v1.6` |
| Python | 整合包内嵌 `python\python.exe`（3.11.9） |
| ComfyUI | 0.3.19（torch 2.5.1+cu124，xformers 0.0.28.post3） |
| GPU | NVIDIA GTX 1050 Ti 4GB（LOW_VRAM 模式） |
| 启动命令 | 工作目录 `...\ComfyUI`，`..\python\python.exe main.py --port 8188 --listen 127.0.0.1 --lowvram` |
| 本次服务 PID | 28212（出图结束后已关闭，8188 端口已释放） |
| 生成方式 | ComfyUI HTTP API：`POST /prompt` → 轮询 `/history/<id>` → `GET /view` 下载 |

启动时 `comfy_extras\nodes_audio.py` 因 `torchaudio\lib\libtorchaudio.pyd` 缺失报 ImportError，属音频节点不可用，不影响文生图；自定义节点加载约 3~4 分钟，`/system_stats` 返回 200 后才开始出图。

模型选择：只用 SD1.5 系 `anything-v5-PrtRE.safetensors`（2.0GB）。
`caajsdxl_1.0`（SDXL 6.5GB）和 `TQing_国风摄影大模型_v1.00`（11GB）在 4GB 显存上会爆显存，**未使用**。
现有 LoRA 均为人物/真实皮肤/末日场景/毛绒海报，与本主题无关，**全部未使用（loras = []）**。

通用采样：`euler_ancestral` + `normal`；无高清修复、无 ControlNet，直接 txt2img。

---

## 1. mascot-fish.png — 大肥鱼吉祥物

- 尺寸/格式：512×512，RGBA（透明背景），128,767 字节
- 画面：Q 版圆胖蓝鲸/胖鱼，大眼、浅蓝肚皮、白色高光，干净粗描边 + 平涂赛璐璐，适合启动器内 200px 装饰
- 后处理：从四角泛洪抠白底（R,G,B 均 >238 且通道最大差 <12 判为背景），边缘 1px 羽化（alpha 180~255 按亮度过渡）+ 0.6px 高斯柔化，输出 RGBA；透明像素占 37.7%，保留约 1.9% 抗锯齿过渡边

| 参数 | 值 |
| --- | --- |
| checkpoint | `anything-v5-PrtRE.safetensors` |
| LoRA | 无 |
| 分辨率 | 512×512 |
| seed | 20261029 |
| steps / cfg | 22 / 7.0 |
| sampler / scheduler | euler_ancestral / normal |
| 耗时 | 98.8s（含首次加载模型；后续同模型单张约 30s） |
| prompt id | 240c3cc2-ced2-478b-b445-8572f1be4659 |

正向 prompt：

```text
chibi mascot character, one very chubby round blue whale, deepseek brand blue color, big cute shiny eyes, small fins, kawaii, flat color illustration, clean bold outlines, simple cel shading, solo, full body, centered, isolated on pure white background, no humans
```

负向 prompt：

```text
text, watermark, signature, blurry, photo, 3d render, realistic, detailed background, multiple characters, cropped, deformed, ugly, jpeg artifacts, human, person, dark background
```

> 备注：身体蓝比品牌色 `#4d6bfe` 偏浅（天空蓝系），在深色 UI 上观感更轻。如后续要严格贴品牌蓝，可对非白色区域做一次色相/饱和度调整。

## 2. tile-grass.png — 可平铺像素草地（俯视）

- 尺寸/格式：512×512，RGB，14,608 字节
- 画面：俯视无透视的 16-bit 像素草地，Minecraft 草绿配色，纯纹理填满画面、无阴影无留白
- 可平铺性：先像素化再以 2D 余弦权重把 4 份平移副本重叠成严格周期纹理（接缝处权重为 0，数学上无边界接缝），3×3 平铺实测无可见接缝
- 后处理：BOX 缩到 128×128 → 调色板映射到 8 色 Minecraft 草绿 `#2f4f1a → #9adf62` → 4 副本余弦重叠周期化 → NEAREST 放大到 512

| 参数 | 值 |
| --- | --- |
| checkpoint | `anything-v5-PrtRE.safetensors` |
| LoRA | 无 |
| 分辨率 | 512×512 |
| seed | 20261050 |
| steps / cfg | 24 / 7.0 |
| sampler / scheduler | euler_ancestral / normal |
| 耗时 | 30.3s |
| prompt id | 879433be-d94a-4bd9-8b98-1196e9fbe616 |

正向 prompt：

```text
green grass texture, top view, pixel art, 16-bit, seamless tileable background, flat grass field, uniform small grass pixels, bright green with darker green tufts, background texture, evenly distributed, no objects, no text
```

负向 prompt：

```text
text, watermark, signature, blurry, photo, 3d render, realistic, jpeg artifacts, cube, isometric, 3d block, object, icon, border, frame, blank margins, perspective, horizon, landscape, terrain, ring, circle, diamond, logo, centered object, single object
```

尝试记录（同模型，均 512×512 / 24 steps / cfg 7.0 / euler_ancestral）：
`20261030`（等距草方块）、`20261033/34`（环形/等距）、`20261040/41/42`（单个立方体/竖条纹/菱形图案）、`20261051`（majicmix7 出写实草坪带地平线，未采用）。
SD1.5 对 "minecraft grass block" 容易理解成「等距草方块物体」，最终用「grass texture + 大量负向词排除 cube/isometric/object」才得到平铺纹理，再做像素化/调色板/无缝化后处理。

## 3. bg-hero.png — 横向背景插画

- 尺寸/格式：1024×576，RGB，396,347 字节
- 画面：黄昏的方块世界山丘、草方块台地、远处方形云；整体偏暗、低对比，左侧为暗部留白，可压白色标题与按钮（左侧 35% 区域平均亮度 76 / 255，白字对比充足）
- 后处理：饱和度 ×0.72、对比度 ×0.82、整体压暗 + 左侧 0.52→1.0 渐变压暗、叠 14% 深蓝（#10183a）、轻微暗角

| 参数 | 值 |
| --- | --- |
| checkpoint | `anything-v5-PrtRE.safetensors` |
| LoRA | 无 |
| 分辨率 | 1024×576 |
| seed | 20261031 |
| steps / cfg | 24 / 6.5 |
| sampler / scheduler | euler_ancestral / normal |
| 耗时 | 83.1s |
| prompt id | dd1320e3-224c-4113-aa45-55148b25582b |

正向 prompt：

```text
pixel art landscape, wide shot, dusk golden hour, blocky voxel world hills, minecraft style terrain, grass blocks, square pixel clouds in sky, distant mountains, flat shading, 16-bit, low contrast, dark muted blue and teal palette, calm evening sky, left side empty sky with no objects for text, cinematic wide composition, no text
```

负向 prompt：

```text
text, watermark, signature, blurry, photo, 3d render, realistic, jpeg artifacts, bright saturated colors, busy composition, characters, people, ui, hdr, lens flare, high contrast, black background
```

> 另试过 seed `20261032`（prompt 强调 dark dusk / muted），出图过灰、只剩山脊剪影，不如 seed 20261031 的构图，故采用后者。

## 4. icon-pack.png — 像素图标组（加分项）

- 尺寸/格式：1152×416，RGBA（透明底），3,765 字节
- 画面：三个 320×320 深色像素卡片，分别为「下载」「模组（拼图）」「设置（齿轮）」，DeepSeek 蓝 `#4d6bfe` + 浅蓝高光，像素网格 40×40、每格 8px，硬边无抗锯齿
- 来源说明：**这张是 Pillow 程序化绘制的**。SD1.5 试了 2 次（prompt 要求 download/settings/puzzle 图标），分别出成「Minecraft 方块纹理」和「二次元角色卡」，图标语义不可控，因此改用像素脚本保证语义正确；脚本见 `art/_tools/draw_icons.py`，随机纹理种子固定，可复现

---

## 复现方式

`art/_tools/` 保留了本次使用的最小工具链（用整合包内嵌 Python 运行，无第三方安装）：

| 文件 | 作用 |
| --- | --- |
| `make_job.py` | 把 `spec_*.json` 变成 ComfyUI `/prompt` 的 API workflow |
| `comfy_gen.py` | 提交 + 轮询 + 下载，并把参数/耗时写进 `*.png.json` |
| `run_batch.py` | 按 `specs_batch.json` 批量跑 |
| `postprocess.py` | 抠白底 / 背景压暗 / 草坪像素化调色板无缝化 / 平铺预览 |
| `mirror_tile.py` | 镜像无缝拼块（备选方案，本次最终未采用） |
| `draw_icons.py` | icon-pack 像素绘制 |

示例（服务已在 8188 运行）：

```bat
set PY=D:\ai comfy ui\ComfyUI-aki(2)\ComfyUI-aki-v1.6\python\python.exe
%PY% D:\QDOQMC\art\_tools\make_job.py spec.json job.json
%PY% D:\QDOQMC\art\_tools\comfy_gen.py job.json
%PY% D:\QDOQMC\art\_tools\postprocess.py mascot in.png out.png
```

三个 AI 资产的完整参数（prompt/seed/耗时/original ComfyUI 文件名）同时留存在 `art/_tools/raw/*.png.json` 里，原始未后处理的 ComfyUI 输出也在同目录（`mascot.png` / `tile.png` / `bg.png`），可直接重跑或重新调后处理。

## 交付清单

| 文件 | 尺寸 | 格式 | 字节数 | 说明 |
| --- | --- | --- | --- | --- |
| `mascot-fish.png` | 512×512 | RGBA | 128,767 | 大肥鱼吉祥物，透明底 |
| `tile-grass.png` | 512×512 | RGB | 14,608 | 无缝像素草地砖块 |
| `bg-hero.png` | 1024×576 | RGB | 396,347 | 黄昏方块世界背景，左侧留白 |
| `icon-pack.png` | 1152×416 | RGBA | 3,765 | 下载/模组/设置像素图标组 |

全部 PNG、单张远小于 1.5MB、宽度均 ≤1600px。ComfyUI 服务在出图完成后已停止（PID 28212），8188 端口无监听。
