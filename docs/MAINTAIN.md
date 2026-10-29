# QDOQMC 维护手册

给「一个人长期维护这个启动器」用。按顺序看：先看第 1 节知道每周要做什么，再看第 2 节知道哪些上游服务一挂你就得动，第 3 节是发版流程，后面是排障和安全。

---

## 1. 维护节奏（按时间）

| 频率 | 要做的事 | 大概耗时 | 不做会怎样 |
|---|---|---|---|
| **每周** | 跑一次 `npm run typecheck` + `npm run smoke`，看有没有红 | 3 分钟 | 依赖悄悄坏了，用户先发现 |
| **每周** | 看 `logs/` 里 ERROR 数量和最高频错误（`npm run smoke` 结束会打印日志目录） | 5 分钟 | 不知道真实用户在踩什么坑 |
| **每两周** | 跟着看一眼上游：Mojang 版本清单、Fabric/NeoForge/Forge meta、Modrinth API 是否还 200 | 10 分钟 | 接口改版 → 用户装不了游戏 |
| **每两周** | 手动装一次「最新正式版 + Fabric」，启动进游戏，确认中文、能加模组 | 20 分钟 | 关键链路退化没人发现 |
| **每月** | 依赖升级：`npm outdated`，优先 Electron / esbuild / React / Cordis 的安全更新 | 30 分钟 | 攒三年后升级地狱 |
| **每月** | 打个新包，更新 `dist/latest.json`，给老版本能自动更新 | 15 分钟 | 用户手里全是老版本 |
| **每次改代码** | 提交前：typecheck + build + smoke + 看截图 | — | 带病发布 |
| **每季度** | 看一次数据：安装成功率、崩溃率、最常用的版本/加载器组合（`telemetry` 事件表） | 1 小时 | 优化方向靠猜 |

> 只保留一条纪律也可以：**发版前必须 `npm run smoke` 绿 + 手动启动一次游戏**。这条能挡掉 90% 的低级事故。

---

## 2. 上游依赖清单（这些一挂，启动器就"装不了游戏"）

| 上游 | 用来做什么 | 挂了的症状 | 应对 |
|---|---|---|---|
| `piston-meta.mojang.com` | 版本清单、版本 JSON、客户端 jar | 版本列表空、装不了原版 | 设置里切 `bmclapi` 镜像；代码里 `mirrorUrl()` 已做域名重写 |
| `bmclapi2.bangbang93.com`（[BMCLAPI](https://github.com/bangbang93/openbmclapi)） | 国内镜像：版本/库/资源文件 | 国内用户下载慢或失败 | `downloadSource: 'auto'` 会自动回落到官方源，不会把用户卡死 |
| `resources.download.minecraft.net` | 贴图/音效/语言文件（assets） | 进游戏没声音没贴图、一直卡在"下载资源" | 同上，镜像里有 `/assets/` |
| `libraries.minecraft.net` | Java 依赖库 | 启动报 `NoClassDefFoundError` | 同上，镜像里有 `/maven/` |
| `meta.fabricmc.net` | Fabric loader 版本 JSON/库 | 「装 Fabric」失败 | 只用 Fabric 时影响明确；报错会带 HTTP 状态 |
| `maven.neoforged.net` | NeoForge 版本与安装器 | NeoForge 装不了 | 明确提示；NeoForge 本身也依赖 maven 可用 |
| `files.minecraftforge.net` / Forge maven | Forge 推荐版本、安装器、processor | Forge 装不了（老版本尤甚） | Forge 官方安装器本身要联网跑 processor，失败时给清晰报错 |
| `api.modrinth.com/v2` | 模组/资源包/光影/整合包搜索与下载 | 模组搜索空、装模组 404 | 搜索失败不崩，只报错；可考虑加镜像/备用源（见 §9） |
| `api.curseforge.com` | `.zip` 整合包解析（需要用户自己的 API Key） | CurseForge 整合包装不了 | 没 Key 时只支持自带 mods 的包，UI 里已经提示 |
| `login.microsoftonline.com` → Xbox → Minecraft Services | 微软正版登录 | 正版登录失败 | 离线登录仍可用；device code 过期会给提示 |
| 自己的更新清单（`latest.json`） | 自动更新 | 检查更新失败 | 只有状态栏变红，不影响玩 |

**判断上游有没有改版的最快方法**：`scripts/p28-check.mjs` 之类的小脚本直接打一次接口（见 §3.3），比开整个 App 快得多。

---

## 3. 发版流程（自动化更新链路）

### 3.1 改版本号
- `package.json` 的 `version`
- `scripts/make-feed.mjs` 读的就是这个版本号

### 3.2 构建 + 打包
```powershell
cd D:\QDOQMC
npm run typecheck
npm run smoke          # 必须绿
npm run build          # out/
npm run package        # dist/QDOQMC-win32-x64/ + zip
npm run make-feed      # 生成 dist/latest.json（含 sha256 和大小）
```
`dist/latest.json` 里的 `sha256` 必须和新 zip 一致，否则老版本下载完校验失败不会更新。发布时把 `latest.json` 和 zip 一起传上去，**先传 zip 再传 latest.json**。

### 3.3 联调小工具
- `scripts/p28-check.mjs`：直接验证下载器/镜像/分片（不启动 UI）
- `scripts/mock-llm.mjs` / `mock-auth.mjs` / `mock-cf.mjs`：本地假服务，测 AI、登录、CurseForge 链路
- `npx electron . --smoke`：全流程 UI 冒烟，跑完在 `out/` 出截图
- `npx electron . --install=1.20.1 --launch=default`：CLI 装/启动，不弹窗口

> 所有测试都建议用隔离数据目录，别碰真实用户数据：
> ```powershell
> $env:QDOQMC_DATA_DIR="$env:TEMP\qdo-test"; $env:QDOQMC_USER_DATA="$env:TEMP\qdo-test-ud"
> ```

---

## 4. 日志与排障入口

| 位置 | 内容 |
|---|---|
| `<数据目录>\logs\main.log` | 主进程结构化日志（JSON 行）：每个插件、每次下载、每次启动 |
| `<数据目录>\logs\` | 按天/大小切割的日志文件 |
| 实例目录 `logs\latest.log` | 这次游戏运行的原始输出（Minecraft 自己的日志） |
| 实例目录 `crash-reports\` | 游戏崩溃报告 |
| UI「日志」按钮 | 启动器日志 / 游戏日志两个 tab，2 秒自动刷新，ERROR/WARN 高亮 |

排障顺序（记住这个就不会乱）：
1. UI 的 toast 说了什么（99% 的失败有中文提示）
2. 启动器日志里 `log.error` 那一行（带 `plugin` 字段）
3. 游戏日志 `latest.log` 最后 50 行
4. 崩溃报告（如果有）
5. 还不行：`--smoke` 复现，看是新代码问题还是环境问题

---

## 5. 回归清单（每两周手动过一遍）

1. 装一个最新正式版（走镜像，观察速度/进度卡/取消是否正常）
2. 在它上面装 Fabric，确认「推荐版本」和实际写入的 loader 版本一致
3. 装一个模组（Sodium 之类），确认 chips 显示支持版本、装进去能加载
4. 启动游戏 → 主菜单是**中文**（`options.txt` 里 `lang:zh_cn`）
5. 改内存 / 换账号 / 切实例 → 再启动
6. 新实例 + 版本隔离：两个实例装不同版本，mods 不串
7. 强制结束游戏进程 → 退出卡片、诊断、一键修复
8. 打包版再跑一遍 1–7（开发版和打包版行为不一致的坑很常见）

---

## 6. 数据与用户文件（绝对不能弄丢的东西）

```
<userData>/                      ← %APPDATA%\QDOQMC
  settings.json                  ← 设置（含本地加密的 Key）
  accounts.json                  ← 账号（DPAPI 加密）
  instances/<id>/instance.json   ← 实例元数据：名字、版本、内存、账号
  plugin-data/                   ← 插件自己的存储
  市场/信任相关
<dataDir>/                       ← 默认 ~/.qdoqmc 或安装目录旁
  versions/  libraries/  assets/  meta/
  instances/<id>/{mods,saves,configs,logs,resourcepacks,shaderpacks}
```

维护红线：
- **不要为了"清理"删 `versions/` 或 `assets/`**——它们被所有实例共享，删了所有版本都要重下。
- 实例删除是破坏性操作，代码里已有二次确认；改这块务必保持确认弹窗。
- 改 `instance.json` 结构时，读取要兼容老字段（现有代码里 `gameVersion ?? versionId` 就是这种兼容写法）。
- 升级前让用户能导出实例（`instances.export` 打成 zip 带 meta.json），出问题能导回来。

---

## 7. 插件生态的维护

- 插件内核是 Cordis：`definePlugin(name, setup)` + `ctx.provide/use`，26 个内置插件就是"第一个用户"。
- 插件跑在**独立子进程沙箱**里（`child_process.fork` + Node `--permission --allow-fs-read=<插件目录>`），只能通过 RPC 拿能力，默认不能读任意文件。
- 对外 API 变更要克制：新增字段一律可选（如 P28 的 `TaskProgress.percent/bytesTotal` 全部 `?`），删除/改名要走版本号 + 兼容层。
- 市场安装有 Ed25519 签名校验；换密钥等于让老市场 feed 全部失效，别轻易换。
- 给插件作者留的最小信息：`docs/PLUGINS.md`（沙箱规则 + feed 格式）。改内核时同步更新它。

---

## 8. 安全与合规

- 用户 API Key：只存本地，走 Electron `safeStorage`（Windows DPAPI）加密后落盘；日志里永远不打印 Key（现有 `secrets.ts` 已做 `enc1:` 前缀标记，日志打码）。
- 遥测默认开、可关，且只上报匿名事件名 + 计数，不上报文件名/路径/账号/聊天内容。
- 不要引入"上传用户存档/实例内容"的功能，除非明确告知并单独开关。
- 自动更新必须有 sha256 校验（已有），且失败要能回退到旧版本继续用。
- 第三方内容（模组/整合包）只做"下载安装"，不执行其中的脚本；`.mrpack`/CurseForge 解析只读清单。

---

## 9. 为什么 PCL 下载那么快、资源那么多（以及我们要补什么）

这不是魔法，是四件事叠起来：

1. **国内镜像源**。Mojang 的资源本体托管在 Amazon S3（国外），国内直连常常几十 KB/s。BMCLAPI 是社区做的镜像（[项目主页](https://github.com/bangbang93/openbmclapi)，明确写着"为解决国内线路对 Forge 和 Minecraft 官方使用的 Amazon S3 速度缓慢的问题"），把版本清单、jar、库、assets 全部转存到国内节点。PCL 默认就走它（还能自动选源/测速），所以"快"的第一层就是**换了个近的服务器**。
2. **多线程分片下载**。一个大 jar 切成若干段，用 HTTP Range 并发拉，再合并。单连接受限于服务端限速和丢包，多连接能把带宽吃满。PCL 的下载线程数可调，这就是第二层。
3. **并发下载多个文件**。库文件和 assets 是成千上万个小文件，串行下载的时间几乎全花在等网络往返上；开十几个并发就快一个数量级。
4. **资源站 API 聚合 + 社区缓存**。PCL 的"资源多"来自同时接多家：Modrinth、CurseForge，加上国内镜像站/整合包站的分发；并且维护了大量本地缓存与"已下载不重下"的判断（我们也是：内容寻址缓存 + 断点续传 + sha1 跳过）。

**QDOQMC 现在做到哪一步**（P28）：
- ✅ 镜像源：`downloadSource: auto|bmclapi|official`，`mirrorUrl()` 统一重写 6 类官方域名
- ✅ 分片下载：大文件按 `downloadThreads` 切段并发（默认 4），服务端不支持 Range 自动回退
- ✅ 多文件并发 + 内容寻址缓存 + 断点续传 + sha1 校验
- ✅ 进度透明：阶段清单、总百分比、实时速度、剩余时间、当前文件、取消
- ⏳ 还没做：多镜像源并存/自动测速轮换、Modrinth/CurseForge 国内镜像、整合包增量更新、P2P（不做）

**下一步最值钱的一件事**：给 Modrinth 下载也加镜像/备用域名（现在模组从 `cdn.modrinth.com` 直连，国内偶发慢）。这需要一张可信的镜像表，别自己写死一个不可靠的域名。

---

## 10. 商业化准备（暂时不赚钱，但别白干）

已经预留的钩子：
- 用户自带 API Key（模型钱由用户出，你不背成本）
- 匿名事件统计（`telemetry`）：安装量/成功率/版本分布 → 以后谈合作、做推荐、算增长
- 插件市场 + 签名（以后可以放付费插件 / 官方插件）
- 更新链路（以后可以灰度发布、强制更新）

真开始收钱前必须先办的三件事（按顺序）：
1. 明确"卖什么"：插件订阅 / 云存档 / 整合包分发 / 广告位——不要卖"启动器本身"。
2. 合规清单：ICP 备案（有服务器就要）、支付渠道（微信/支付宝商户）、隐私政策、退款规则、生成式 AI 备案（如果内置 AI 功能对公众提供）。
3. 成本模型：云存档和整合包 CDN 是主要成本项，先算清楚"每个付费用户每月成本"再定价。

---

## 11. 常见故障速查

| 症状 | 先查 | 常见原因 |
|---|---|---|
| 版本列表是空的 | 网络 + `downloadSource` | Mojang/BMCLAPI 都不通；公司网络拦 HTTPS |
| 下载卡在某阶段不动 | 进度卡"正在下载"的文件 | 单个大文件被限速；调小 `downloadThreads` 或切官方源 |
| 装完还是"未绑定版本" | 是否点了「安装」按钮（P28 起绑定是安装的一部分） | 老版本 UI 装原版不绑定 |
| 启动闪退、`NoClassDefFoundError` | 实例目录 `logs\latest.log` | 库文件缺失（删了 libraries/）、Java 版本不对 |
| 进游戏是英文 | `options.txt` 的 `lang` | 玩家手动选过英文；启动前会自动改 `en_us`→`zh_cn` |
| 模组装了不生效 | 实例 loader 与模组要求是否一致 | 装到 vanilla 实例、Fabric 模组装到 Forge |
| 模组搜索没有结果 | 实例绑定的版本/加载器 | 过滤太严；换成选中版本的正式版再搜 |
| 微软登录卡住 | 系统时间、`msClientId` | device code 过期；Azure 应用没配 redirect |
| 自动更新没反应 | `latest.json` 的 sha256 | 传了旧清单、zip 没传完 |

---

## 12. 最小维护脚本清单

```powershell
# 每天/每次提交前
npm run typecheck
npm run smoke

# 每周
npx electron . --smoke --smoke-settings 
node scripts/p28-check.mjs        # 下载器 + 镜像实测

# 每次发版
npm run build; npm run package; npm run make-feed
```

如果这些命令有一条在你机器上跑不起来，说明环境已经漂了，先修环境再改代码。
