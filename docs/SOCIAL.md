# 自动运营（短视频生成）

> 目标：每天自动产出一条 30 秒竖屏视频（封面 + 录屏 + 配音字幕）+ 一份文案，人工上传到 B 站/小红书。

## 一条命令

```bash
python scripts/social/make.py --theme fix
```

产物在 `social/<日期>/`：

| 文件 | 用途 |
|---|---|
| `video.mp4` | 1080×1920 竖屏，30 秒左右，已含封面、录屏、配音、字幕 |
| `cover.png` | 封面图（也可单独当小红书首图） |
| `caption.txt` | B 站/小红书两版文案 + 标签，直接复制 |
| `meta.json` | 本次用了哪个主题 |

## 每天自动跑

已注册 Windows 计划任务 `CubeFish-DailySocial`，每天 20:00 自动生成（需要电脑开机且已登录）。

```powershell
# 查看
Get-ScheduledTask -TaskName 'CubeFish-DailySocial'
(Get-ScheduledTaskInfo -TaskName 'CubeFish-DailySocial').NextRunTime

# 改时间
$t = New-ScheduledTaskTrigger -Daily -At 21:30
Set-ScheduledTask -TaskName 'CubeFish-DailySocial' -Trigger $t

# 删除
Unregister-ScheduledTask -TaskName 'CubeFish-DailySocial' -Confirm:$false
```

## 它是怎么做的

1. 启动启动器 `--demo`（脚本化走一遍界面：主界面 → 下载中心 → 插件 → AI → 系统）
2. 用 ffmpeg `gdigrab` 录窗口区域（先按 PID 找窗口矩形，避免 GPU 窗口黑屏）
3. Windows SAPI 中文语音（Huihui）按每个步骤的时间点合成配音
4. Pillow 生成封面/字幕条
5. ffmpeg 合成竖屏：封面 2.5s + 录屏（模糊背景 + 居中画面）+ 字幕叠加 + 配音

## 改内容

- **主题/文案**：改 `scripts/social/make.py` 里的 `THEMES`（`title` + 每个步骤的 `lines`）
- **录制步骤**：改 `src/main/index.ts` 里的 `runDemoMode()`（`step('xxx')` 打点，顺序即视频顺序）
- **演示模式不花钱**：只点面板/搜索/输入，不调用模型、不装东西

## 发布流程（人工 2 分钟）

1. 打开 `social/<日期>/`
2. B 站：上传 `video.mp4`，标题/简介/标签复制 `caption.txt`；可设定时发布
3. 小红书：上传 `video.mp4`（竖屏正好），首图可用 `cover.png`，正文复制 `caption.txt`
4. 发完把目录挪到 `social/_posted/`，方便统计

> 提示：不要在录制时开着隐私窗口/消息软件，录的是屏幕区域。
