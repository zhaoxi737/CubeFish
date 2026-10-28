# QDOQMC 技术参考手册：下载 / 启动 / 加载器 / 内容源 / 冲突判据 / 目录布局（P1–P2）
> 服务对象：`docs/PLAN.md` 的 F1–F5、F8–F10。标记：**✅** = 2026-10-28 实际拉取 JSON / 解包 jar 核对；**⚠️** = 公开文档或成熟实现，未逐项实测；**❓** = 未验证，开工前必须实测。
> 网络前提：`piston-meta/piston-data/libraries/resources/launchermeta.mojang.com`、`meta.fabricmc.net`、`maven.neoforged.net`、`api.modrinth.com` 当前可直连；大陆需预留镜像回退（§1.3），默认官方。
> 代码/字段名用英文；示例 JSON 均为截断版，"…"表示省略。
## 0. 通用约定（所有下载器共用）
- 落盘：写 `xxx.part` → 校验 `size`+`sha1` → `rename()` 原子替换；失败重试 3 次（指数退避 + 镜像切换）；断点续传用 `Range: bytes=<len>-`，仅 206 才续。
- 并发：Mojang 无公开限流，全局 ≤16、单域名 ≤8；Modrinth ≤300 req/min（✅ 响应头 `X-Ratelimit-Limit: 300`），客户端限 2–3 req/s。
- `User-Agent`：Modrinth 要求可识别（`QDOQMC/0.1.0 (+https://qdoqmc.example/contact)`）；Mojang 不校验但统一携带。
- 路径：内存统一 POSIX `/`，落盘转 `\`；Maven 路径 = `group.replace('.','/')/artifact/version/artifact-version[-classifier].jar`（§1.2/§3 合并库的核心函数）。
- 校验一律流式 sha1，不整文件读内存；sha1 同时是内容寻址 key（§6 缓存）。
- 所有下载任务落 SQLite `download_tasks`（url/dest/hash/size/status/attempts），UI 可续跑。
## 1. Mojang 官方下载接口
### 1.1 `version_manifest_v2.json` ✅
```
https://piston-meta.mojang.com/mc/game/version_manifest_v2.json
备用 https://launchermeta.mojang.com/mc/game/version_manifest_v2.json   // ⚠️ 同内容
```
```json
{"latest": {"release": "26.3", "snapshot": "26.4-snapshot-6"},
 "versions": [
   {"id": "26.3", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/5df1795e.../26.3.json",
    "time": "2026-10-27T06:57:57+00:00", "releaseTime": "2026-09-15T11:23:02+00:00",
    "sha1": "5df1795e16eea19d75b923d66ecca9ce183353c5", "complianceLevel": 1},
   {"id": "1.6.4", "type": "release", "url": "https://piston-meta.mojang.com/v1/packages/b71bae44.../1.6.4.json",
    "sha1": "b71bae449192fbbe1582ff32fb3765edf0b9b0a8", "complianceLevel": 1}]}
```

| 字段 | 含义 |
|---|---|
| `latest.release` / `latest.snapshot` | 最新正式版 / 快照 id，仅展示 |
| `versions[].id` | 版本名 = 目录名 = `--version` 值 |
| `versions[].type` | 枚举 ✅：`release`(103) / `snapshot`(757) / `old_beta`(26) / `old_alpha`(35) |
| `versions[].url` | version json 完整 URL，**不要自己拼** |
| `versions[].sha1` | version json 文件 sha1，下载后必须校验（与 url 的 sha 段一致 ✅） |
| `releaseTime` / `time` | 发布时间 / 元数据刷新时间，排序用 `releaseTime` |
| `complianceLevel` | 1 = 已符合新聊天签名合规，仅记录 |
注意：`versions` 时间倒序但不要依赖；`old_alpha` 的 assets 同 pre-1.6 处理（❓ 需抽测）。
### 1.2 单版本 version json ✅
URL 取自 `versions[].url`，当前形态 `https://piston-meta.mojang.com/v1/packages/{sha1}/{id}.json`；2018 年前的老版本仍可能指向 `launchermeta.mojang.com`（✅ 1.6.4 的 assetIndex 就是），**始终用 JSON 内 url**。
```json
{"id": "1.21.11", "type": "release", "complianceLevel": 1, "minimumLauncherVersion": 21,
 "mainClass": "net.minecraft.client.main.Main", "assets": "29",
 "assetIndex": {"id": "29", "sha1": "0e43ee53...", "size": 529966, "totalSize": 452888471, "url": "https://piston-meta.mojang.com/v1/packages/0e43ee53.../29.json"},
 "downloads": {"client": {"sha1": "ba2df812...", "size": 31152600, "url": "https://piston-data.mojang.com/v1/objects/ba2df812.../client.jar"},
               "server": {"…": "…"}, "client_mappings": {"…": "…"}},
 "javaVersion": {"component": "java-runtime-delta", "majorVersion": 21},
 "logging": {"client": {"argument": "-Dlog4j.configurationFile=${path}", "type": "log4j2-xml",
                        "file": {"id": "client-1.21.2.xml", "sha1": "39384bd1...", "size": 1073, "url": "https://piston-data.mojang.com/v1/objects/39384bd1.../client-1.21.2.xml"}}},
 "arguments": {"game": ["--username", "${auth_player_name}", "…"], "jvm": ["-Djava.library.path=${natives_directory}", "…"]},
 "libraries": [
   {"name": "at.yawk.lz4:lz4-java:1.8.1",
    "downloads": {"artifact": {"path": "at/yawk/lz4/lz4-java/1.8.1/lz4-java-1.8.1.jar",
                               "sha1": "1f30a180...", "size": 683071,
                               "url": "https://libraries.minecraft.net/at/yawk/lz4/lz4-java/1.8.1/lz4-java-1.8.1.jar"}}},
   {"name": "ca.weblite:java-objc-bridge:1.1", "rules": [{"action": "allow", "os": {"name": "osx"}}],
    "downloads": {"artifact": {"path": "ca/weblite/...", "url": "https://libraries.minecraft.net/ca/weblite/..."}}}]}
```

| 节点 | 含义 / 实现要点 |
|---|---|
| `mainClass` | 原版 `net.minecraft.client.main.Main`；加载器覆盖（Fabric=`...KnotClient`，Forge/NeoForge=`cpw.mods.bootstraplauncher.BootstrapLauncher`） |
| `inheritsFrom` | 仅加载器版本有：父版本 id，启动前递归合并（§2.3） |
| `downloads.client` | 客户端 jar；`downloads.server` 仅服务端用，可忽略 |
| `assetIndex` | `id` = 目录名，`sha1` 校验，`totalSize` 用于进度 |
| `assets` | 索引 id 冗余（1.6.4=`legacy` ✅，1.5.2=`pre-1.6` ✅）；以 `assetIndex.id` 为准 |
| `javaVersion` | 1.12.2 起出现；1.6.4 无 ✅ → 回退规则见 §1.5 |
| `arguments` / `minecraftArguments` | 1.13+ 用前者；≤1.12.2 用后者（§2.4） |
| `logging` | 下载 `file.url`，把 `argument` 的 `${path}` 换成本地路径塞 JVM 参数 |
| `libraries[].downloads.artifact` | `path`（库根下相对路径）/`url`/`sha1`/`size`；老版本还有 `downloads.classifiers`（§2.2） |
| `libraries[].url` | 仅加载器库有：Maven 仓库根，无 `downloads`，需按坐标拼路径 + 用 sha1/size 校验 |
### 1.3 域名与路径规则 ✅

| 内容 | URL 模板 | 校验 |
|---|---|---|
| 客户端 jar | `{downloads.client.url}` = `https://piston-data.mojang.com/v1/objects/{sha1}/client.jar` | `client.sha1` |
| 库 jar | `https://libraries.minecraft.net/{artifact.path}` | `artifact.sha1` |
| 资源对象 | `https://resources.download.minecraft.net/{hash[0:2]}/{hash}`（✅ 200） | `objects[k].hash` |
| 资源索引 | `{assetIndex.url}`（`/v1/packages/{sha1}/{id}.json`） | `assetIndex.sha1` |
| 日志配置 | `{logging.client.file.url}`（piston-data objects） | `file.sha1` |
| Java 运行时 | `https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json` → 组件 `manifest.url`（piston-meta）→ `files[].downloads.raw.url`（piston-data） | `manifest.sha1` / `raw.sha1` |
| 加载器库 | Fabric `{libraries[].url}`+Maven 路径；Forge `maven.minecraftforge.net`；NeoForge `maven.neoforged.net/releases` | 各自 sha1 |
- 优先用 JSON 给的 url；只有加载器库需要拼 Maven 路径。所有 JSON 带 sha1/size，连续 3 次校验失败则报错并给可复制 URL。
- 可选镜像（默认关闭）：BMCLAPI `https://bmclapi2.bangbang93.com`（❓ 路径映射与官方不同，需实测），UI 需明示"使用镜像"。
- `libraries.minecraft.net` 只读无鉴权；不要用 piston-data 当库源。
### 1.4 assetIndex、objects 与虚拟文件系统 ✅
索引存 `assets/indexes/{id}.json`，对象存 `assets/objects/{hash[0:2]}/{hash}`（与 resources 域名同构）：
```json
{"objects": {"icons/icon_16x16.png": {"hash": "bdf48ef6b5d0d23bbb02e17d04865216179f510a", "size": 3665},
             "minecraft/sounds/mob/zombie/say1.ogg": {"hash": "d1e8b8...", "size": 12345}},
 "virtual": true}
```

| 索引 id | 版本 | 索引标记 | 额外动作 | `--assetsDir` |
|---|---|---|---|---|
| 数字（`1.8`/`12`/`29`） | 1.7.2+ | 无 | 不物化，直读 objects | `assets/` 根 |
| `legacy` | 1.6.x | `virtual: true` ✅ | 物化到 `assets/virtual/legacy/{key}` | `assets/virtual/legacy`（旧版 `${game_assets}` 指此，⚠️ 语义待实测） |
| `pre-1.6` | ≤1.5.2 | `map_to_resources: true` ✅ | 物化到 `<gameDir>/resources/{key}`（老版本从这里读音频），可同时物化 virtual/pre-1.6 兜底 | `assets/virtual/pre-1.6`（⚠️ 待实测） |
- 物化用硬链接（同卷）或复制；已存在且 size 相同跳过，可断点续跑。
- 体积：legacy `totalSize`≈153 MB（1.6.4 ✅）；pre-1.6≈49.5 MB（1.5.2 ✅）；现代索引可达 452 MB+（1.21.11 ✅）→ 必须按需下载。
- 1.7.10 索引既无 virtual 也无 map_to_resources ✅ → 按数字 id 处理。
### 1.5 官方 Java 运行时清单 ✅
```json
// https://launchermeta.mojang.com/v1/products/java-runtime/2ec0cc96c44e5a76b9c8b7c39df7210883d12871/all.json
{"windows-x64": {"java-runtime-delta": [{
   "manifest": {"sha1": "cb4394a2...", "size": 148529, "url": "https://piston-meta.mojang.com/v1/packages/cb4394a2.../manifest.json"},
   "version": {"name": "21.0.7", "released": "2025-05-19T08:34:42+00:00"}}],
 "jre-legacy": [{"manifest": {"url": "https://piston-meta.mojang.com/v1/packages/.../manifest.json"}, "version": {"name": "8u..."}}]}}
```
- 平台键 ✅：`windows-x64`/`windows-x86`/`windows-arm64`/`mac-os`/`mac-os-arm64`/`linux`/`linux-i386`/`gamecore`。
- 组件键 ✅（win-x64）：`jre-legacy`、`java-runtime-alpha|beta|gamma|delta|epsilon|gamma-snapshot`、`minecraft-java-exe`。
- 流程：`javaVersion.component` → `all[platform][component][0]` → 下载 `manifest.url` 校验 `sha1` → 解包 `files`。
- `files` 条目 ✅：`{"type":"file","downloads":{"raw":{"url","sha1","size"},"lzma":{...}},"executable":true}`；另有 `{"type":"directory"}`、`{"type":"link","target"}`。
- **坑**：`executable:true` 不可靠（✅ 实测 DLL 也标 executable）；按 `bin/javaw.exe`/`bin/java.exe` 是否存在判断。`lzma` 更小但需 xz 解码，P1 用 `raw`。
- 映射（✅ 从 version json）：1.16.5→`jre-legacy`(8)；1.18.2→`java-runtime-beta`(17)；1.20.1→`java-runtime-gamma`(17)；1.21.11→`java-runtime-delta`(21)；1.6.4 无字段 ✅ → 按 8 处理；1.12.2 按 8（⚠️ 其 javaVersion 值未逐字段确认）。
- 存放 `runtimes/{component}/{version}/`，可执行如 `runtimes/java-runtime-gamma/17.0.15/bin/javaw.exe`。下载前先探测本地同 major Java（`java -version` 解析 `version "17.0.x"`，⚠️ 各发行版输出需容错）。
## 2. 启动链
### 2.1 参数模板与 `${...}` 占位符 ✅
顺序固定：`<java>` → 展开后的 JVM 参数 → `mainClass` → 展开后的游戏参数。JVM 参数示例（1.20.1 实测，含 rules 条目）：
```
-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump  // rules: os=windows
-Xss1M                                                                                     // rules: os.arch=x86
-Djava.library.path=${natives_directory}
-Djna.tmpdir=${natives_directory}
-Dorg.lwjgl.system.SharedLibraryExtractPath=${natives_directory}
-Dio.netty.native.workdir=${natives_directory}
-Dminecraft.launcher.brand=${launcher_name}
-Dminecraft.launcher.version=${launcher_version}
-cp ${classpath}
```

| 占位符 | 值 / 备注 |
|---|---|
| `${auth_player_name}` | 玩家名（离线允许任意合法名） |
| `${auth_uuid}` | 32 位无连字符 UUID；离线 = MD5(`OfflinePlayer:<name>`) 按 v3 生成 ⚠️ |
| `${auth_access_token}` | 登录 token；离线填 `-` 或随机 UUID |
| `${auth_session}` | ≤1.6 的 session id（✅ 1.5.2/1.6.4 出现）；离线 `-` |
| `${version_name}` / `${version_type}` | 版本 id / `release`\|`snapshot` |
| `${game_directory}` | 实例游戏目录（= 进程 cwd），Windows 绝对路径 |
| `${assets_root}` / `${assets_index_name}` | 资源根 / `assetIndex.id`（1.7+） |
| `${game_assets}` | 旧版资源路径（1.6.4/1.5.2 ✅），指向 virtual 目录（⚠️ 见 §1.4） |
| `${user_type}` | `legacy` / `mojang`；离线用 `legacy` |
| `${natives_directory}` | natives 目录，建议 `versions/<id>/natives` |
| `${classpath}` / `${classpath_separator}` | classpath（`;`）/ `;`（Forge `-p` 用 ✅） |
| `${library_directory}` | `libraries/` 根（Forge/NeoForge JVM 参数 ✅） |
| `${launcher_name}` / `${launcher_version}` | `QDOQMC` / 版本号，写死 |
| `${resolution_width}` / `${resolution_height}` | 仅 rules 命中 `has_custom_resolution` 时展开 |
**游戏参数禁止硬编码**：现代版本含 `--assetIndex`/`--uuid`/`--accessToken`/`--clientId`/`--xuid`/`--userType`/`--versionType`，以及 `--demo`/`--width`/`--height`/`--quickPlayPath` 等按 rules 条件出现的项；必须以 version json 的 `arguments.game` 原顺序展开后拼接。离线时 `--clientId`/`--xuid` 传 `-`（❓ 个别版本可能校验，需抽测）。
### 2.2 natives 解压策略（三代）✅

| 世代 | 判定 | 处理 |
|---|---|---|
| 老（≤1.18.2，含 1.6.4/1.7.10/1.12.2/1.16.5/1.18.2） | 有 `natives:{windows:"natives-windows"}` + `downloads.classifiers` ✅ | 只下载 `classifiers[natives.windows]`，解压到 `natives/`；`artifact` 仍进 classpath；按 `extract.exclude`（通常 `["META-INF/"]`）过滤；防 zip-slip |
| 新（1.19+，含 1.19.2/1.20.1/1.21.11） | 无 `natives`，而是独立库 `org.lwjgl:xxx:3.3.3:natives-windows` ✅ | 当普通库**加入 classpath**，不解压；仍传 `-Djava.library.path=<空 natives 目录>` 与 LWJGL 临时目录参数 |
| 极老（1.6.4 及更早） | 同老世代（LWJGL 2.9） | 分类器解压；`extract` 可能缺失，默认只排除 `META-INF/` |
- natives 目录按版本隔离，升级/重装时清空重建，避免旧 dll 残留；解压失败回退"重建 + 重试一次"。
- 1.13–1.18.2 的 natives **不进 classpath**（误加会 duplicate native / 崩溃）。
### 2.3 classpath 顺序与 `inheritsFrom` 合并
```
classpath = [父版本 libraries…] + [子版本(加载器) libraries…] + [versions/<id>/<id>.jar]
```
- 递归到根；按 `(group, artifact, classifier)` 去重，**子覆盖父**（不能按完整 name 去重，否则不同版本的 asm 同时出现）。
- 加载器库（`url` 形态）按 Maven 路径加入；只有 `artifact` 的库进 classpath；老世代 `classifiers` 的 natives 不进。
- 客户端 jar 放最后。Windows 命令行上限 32767 字符，大整合包会超 → 用 `@argfile`（Java 9+，每行一个参数，含空格用引号）；Node `spawn(cmd, argsArray)` 不走 shell，但总长度仍受限。
- 路径含 `;`/`%`/中文：数组参数可避免转义；仍建议实例路径禁空格与 `%`（旧 Java `-Djava.library.path` 可能展开 `%` ⚠️）。
### 2.4 `arguments` 与 `minecraftArguments` 双格式

| 格式 | 适用 | 处理 |
|---|---|---|
| `minecraftArguments` 字符串 | ≤1.12.2 ✅ | 按**空格切分** token（旧格式无引号，路径含空格必炸）→ 逐 token 替换占位符 |
| `arguments.game/jvm[]` | 1.13+ ✅ | 元素为 string 或 `{rules, value:string|string[]}`；先求值 rules，value 为数组则展开 |
| 1.5.2 特殊 | ✅ | 以 `${auth_player_name} ${auth_session}` 开头（无 `--` 前缀），按原顺序拼接 |
| 加载器合并 | ✅ | Fabric `arguments.jvm`、Forge `-D…/-p/--add-modules` 一律**追加**，不能替换父版本 |
### 2.5 `rules` 求值
```json
{"action": "allow", "os": {"name": "windows", "version": "^10\\."}, "features": {"is_demo_user": true}}
```
- 条件：`os.name`（`windows`/`osx`/`linux`）、`os.arch`（`x86`=32 位、`x86_64`、`arm64`）、`os.version`（正则，如 `^10\.`）、`features.*`（启动器布尔开关）。
- 求值：顺序遍历命中的 rule，**最后一个命中**的 `action` 生效；无命中默认 `deny`（libraries 与 arguments 同）。`features` 默认 false，仅按 UI 设置置 true。
- 例：1.18.2 的 `-Dos.name=Windows 10` 只在 `os.version ^10\.` 命中时加；Win11 版本号 10.x 也可命中。
### 2.6 进程管理、编码与退出码
- `spawn(java, args, {cwd: gameDir, windowsHide: true, stdio: ['pipe','pipe','pipe']})`；**cwd 必须 = `--gameDir`**（老 mod 相对路径、crash-report/logs 都落 cwd）。
- `env`：继承系统环境即可；不要设 `JAVA_TOOL_OPTIONS`（会被 JVM 打印且可能冲突）、不传 `LC_ALL`/`LANG`。
- 编码（中文 Windows 老 Forge 输出 GBK）：stdout/stderr 按字节累积、按行切分，先严格 UTF-8 解码，失败回退 GBK（`new TextDecoder('gbk')`，Electron 自带 ICU，⚠️ 需在目标版本实测）；Java 8 可加 `-Dsun.stdout.encoding=UTF-8` 但会改变日志行为，默认不加。
- 行处理：兼容 `\r`（进度条）/`\r\n`/ANSI 颜色码（`\u001b[…m`）/超长行截断（前 8 KB）。
- 日志双写：原始字节 `logs/game-<ts>.log`（便于换编码重解）+ 解码行进 `events.jsonl`/UI。Minecraft 自身还写 `logs/latest.log`、`crash-reports/`、JVM 崩溃 `hs_err_pid*.log`（在 cwd）——三处都检测。
- 退出码（Windows，⚠️ 经验表，仅用于归因提示）：`0` 正常（也可能是捕获异常后正常退出 → 必查 crash-report）；`1` 未捕获异常（Mod 加载失败/缺依赖/参数错）；`-1` JVM 内部错误；`-1073741819`(0xC0000005) 访问冲突（显卡/native）；`-1073740791`(0xC0000409) 栈溢出；`-1073741515`(0xC0000135) 缺 DLL（Java 位数不匹配/VC++ 运行库）；`-1073741510`(0xC000013A) Ctrl+C。
- 停止：`child.kill()` → 5 s 未退 → `taskkill /PID <pid> /T /F`；不要 `stdin.end()`（Forge terminal console appender 可能在 EOF 时异常 ⚠️）。启动前同实例互斥锁 + pid 文件。
## 3. 加载器安装
### 3.1 Fabric ✅
```
GET https://meta.fabricmc.net/v2/versions/loader                 // 全部 loader，含 stable
GET https://meta.fabricmc.net/v2/versions/loader/{game}          // 该游戏可用 loader + intermediary
GET https://meta.fabricmc.net/v2/versions/loader/{game}/{loader}/profile/json   // 成品 version json
GET https://meta.fabricmc.net/v2/versions/yarn/{game}            // 映射，启动不需要
```
```json
// 1.20.1 + 最新 loader 实测（截断）
{"id": "fabric-loader-0.20.1-1.20.1", "inheritsFrom": "1.20.1", "type": "release",
 "mainClass": "net.fabricmc.loader.impl.launch.knot.KnotClient",
 "arguments": {"game": [], "jvm": ["-DFabricMcEmu= net.minecraft.client.main.Main "]},
 "libraries": [{"name": "org.ow2.asm:asm:9.10.1", "url": "https://maven.fabricmc.net/", "sha1": "ada2141c...", "size": 126151},
   {"name": "net.fabricmc:sponge-mixin:0.17.5+mixin.0.8.7", "url": "https://maven.fabricmc.net/", "…": "…"}]}
```
安装（纯合并，无安装器进程）：
1. 选 `/v2/versions/loader/{game}` 中 `stable:true` 的最新项；无该 game 条目 = 未支持。
2. 拉 `profile/json`，原样写 `versions/{id}/{id}.json`。
3. 下载 `libraries`：`url` + Maven 路径，`sha1`/`size` 校验，进全局 `libraries/`。
4. 不生成 `versions/{id}/{id}.jar`（`inheritsFrom` 指向父版本）。
5. 启动时按 §2.3 合并：父原版 + 本 profile 的 `mainClass`/`arguments.jvm`/`libraries`；游戏参数用父版本。
6. Fabric API 是普通 Mod（放 `mods/`），不在 loader 内；不要用 fabric-installer jar（仅 GUI 安装用）。
### 3.2 Forge / NeoForge
```
Forge:    https://maven.minecraftforge.net/net/minecraftforge/forge/{mc}-{forge}/forge-{mc}-{forge}-installer.jar
          https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml
NeoForge: https://maven.neoforged.net/releases/net/neoforged/neoforge/{ver}/neoforge-{ver}-installer.jar
          https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml
NeoForge 1.20.1：坐标 net.neoforged:forge（✅ 1.20.1-47.1.106），不是 neoforge
```
安装器 jar 内容 ✅：`install_profile.json`、`version.json`、`data/client.lzma`、`data/server.lzma`。三种 profile 形态：

| 形态 | 判据 | 处理 |
|---|---|---|
| 远古（1.7.10 安装器） | 无 `spec`，有 `install`+`versionInfo` ✅ | `versionInfo` 当 version json；`install.filePath` 的 universal jar 下载到 `libraries/{install.path}/{filePath}`；无 processors |
| spec 0（1.12.2 后期） | `spec:0`、`path`/`json`、无 `data`/`processors` ✅ | 解出 jar 内 `version.json` + 合并 `libraries`，无处理器 |
| spec 1（1.13+、1.20.1、NeoForge） | `spec:1`、有 `data`+`processors` ✅ | 执行 processors 后写版本 json；`path` 为 null/空 ✅ |
spec 1 关键结构（1.20.1 / NeoForge 21.1.265 实测）：
```json
{"spec": 1, "profile": "forge", "version": "1.20.1-forge-47.4.28", "minecraft": "1.20.1",
 "json": "/version.json", "path": null,
 "data": {"MAPPINGS": {"client": "[de.oceanlabs.mcp:mcp_config:1.20.1-20230612.114412:mappings@txt]", "server": "…"},
          "MC_SLIM": {"client": "[net.minecraft:client:1.20.1-20230612.114412:slim]", "server": "…"}, "MC_SLIM_SHA": {"client": "'de86b035d2da0f78940796bb95c39a932ed84834'", "server": "…"},
          "PATCHED": {"client": "[net.minecraftforge:forge:1.20.1-47.4.28:client]", "server": "…"}, "BINPATCH": {"client": "/data/client.lzma", "server": "/data/server.lzma"}, "MCP_VERSION": {"client": "'20230612.114412'", "server": "…"}},
 "processors": [
   {"sides": ["client"], "jar": "net.minecraftforge:jarsplitter:1.1.4",
    "classpath": ["net.sf.jopt-simple:jopt-simple:5.0.4", "net.minecraftforge:srgutils:0.4.3"],
    "args": ["--input", "{MINECRAFT_JAR}", "--slim", "{MC_SLIM}", "--extra", "{MC_EXTRA}", "--srg", "{MERGED_MAPPINGS}"],
    "outputs": {"{MC_SLIM}": "{MC_SLIM_SHA}", "{MC_EXTRA}": "{MC_EXTRA_SHA}"}}],
 "libraries": [{"name": "net.minecraftforge:forge:1.20.1-47.4.28:universal", "downloads": {"artifact": {"path": "…", "sha1": "…", "url": "https://maven.minecraftforge.net/…"}}}]}
```
处理器执行引擎（照此实现）：
```
vars = { SIDE:"client", MINECRAFT_JAR:<versions/mc/mc.jar>, MINECRAFT_VERSION:mc, ROOT:<gameDir>, INSTALLER:<installer jar>, LIBRARY_DIR:<libraries 根> }
for p in processors (保持数组顺序):
  if p.sides 存在 且 SIDE 不在其中: continue        // 仅 server 的跳过
  jarPath = resolve(p.jar)                           // 先查 libraries 已下载，缺失从 maven 下载
  mainClass = 读 jarPath 的 META-INF/MANIFEST.MF 的 Main-Class   // installertools 是 fat jar
  cp = p.classpath.map(resolve).join(sep) + sep + jarPath
  exec java -cp cp mainClass p.args.map(a => substitute(a, vars))   // cwd=ROOT；退出码≠0 立即失败，回传 stderr 尾 50 行
  for (outKey, shaKey) in p.outputs:                 // 建议执行：按 sha1 校验产物
     assert sha1(file(substitute(outKey))) == substitute(shaKey)（去单引号）
  vars 回填产物路径（{MC_SLIM} 等），供后续处理器链式使用
```
`substitute` 的 4 种语法 ✅：`[group:artifact:version(:classifier)(@ext)]` → Maven 坐标映射到 `libraries/` 路径（缺失则下载）；`{KEY}` → `data[KEY][SIDE]`；`/data/client.lzma` → 安装器 jar 内相对路径（解压到临时文件）；`'literal'` → 去单引号的字面量（sha1/版本号）。
1.20.1 处理顺序 ✅：`EXTRACT_FILES`(server) → `BUNDLER_EXTRACT`(server) → `BUNDLER_EXTRACT`(server,jar-only) → `MCP_DATA` → `DOWNLOAD_MOJMAPS` → `MERGE_MAPPING` → `jarsplitter`(client) → `ForgeAutoRenamingTool` → `binarypatcher`。NeoForge 21.1.265 共 10 个，工具换 `net.neoforged.installertools:*`/`net.neoforged:AutoRenamingTool`，`MERGE_MAPPING` 多 `--fields --methods` ✅。
安装后：
- 写 `versions/{version}/{version}.json` = jar 内 `version.json`，`libraries` = 其 libraries ∪ `install_profile.libraries`（去重），保留 `inheritsFrom`；`versions/{version}/` 不需要 jar。
- 产物：`{PATCHED}` → `libraries/net/minecraftforge/forge/{ver}/forge-{ver}-client.jar`，`{MC_SLIM}`/`{MC_EXTRA}` 同理落 Maven 路径。
- ❓**最大未验证点**：1.20.1 的 `version.json` 不含 patched client jar（✅ 已核实），启动依赖 `BootstrapLauncher` + `-DlibraryDirectory` 定位；保守实现把它以 `net.minecraftforge:forge:<ver>:client` 追加进版本 `libraries`（本地存在则跳过下载），若报 module 冲突再移除。P2 开工第一件事：解包 `bootstraplauncher` 或对照 HMCL/Prism 安装产物定论。
- Java：1.20.1 用 17、NeoForge 1.21.1 用 21、1.12.2 用 8（⚠️ 以实测为准）。
Forge vs NeoForge ✅：

| 维度 | Forge | NeoForge |
|---|---|---|
| Maven / 坐标 | `maven.minecraftforge.net`；`net.minecraftforge:forge:{mc}-{forge}` | `maven.neoforged.net/releases`；`net.neoforged:neoforge:{ver}`（1.20.1 用 `net.neoforged:forge`） |
| profile | spec 1，`profile:"forge"` | spec 1，`profile:"NeoForge"`，`path` 空 |
| 处理器工具 | `net.minecraftforge:installertools`、`ForgeAutoRenamingTool` | `net.neoforged.installertools:*`、`net.neoforged:AutoRenamingTool` |
| 映射 | `de.oceanlabs.mcp:mcp_config` / `net.minecraft:client:…:mappings` | `net.neoforged:neoform:{mc}-{date}:mappings` |
| 主类 / launchTarget | `cpw.mods.bootstraplauncher.BootstrapLauncher` / `forgeclient` | 同左 |
| 1.20.5+ mod 元数据 | `META-INF/mods.toml` | `META-INF/neoforge.mods.toml` ✅ |
| 生态 | 1.20.1 及以前为主 | 1.20.2+ 主线 |
失败模式（P2 错误提示）：processor 下载 403（代理/镜像）、Java 版本不符 `UnsupportedClassVersionError`、`outputs` sha 不符（缓存脏）、`launcher_profiles.json` 缺失（仅官方 GUI 安装器要求，自研不需要 ⚠️）。
### 3.3 Quilt：P2 不做
- meta ✅：`https://meta.quiltmc.org/v3/versions/loader`、`/v3/versions/loader/{game}/{loader}/profile/json`；profile 结构同 Fabric（`id`/`inheritsFrom`/`mainClass`/`arguments`/`libraries`，✅ 键名实测，mainClass 具体值 ⚠️）。
- 用户占比低、QSL 停滞、Quilt 专属 mod 少，且多一种 `quilt.mod.json` 解析。结论：P2 只做 Fabric/NeoForge，Quilt 留 P4（meta 可直接合并，不阻塞架构）。
## 4. Modrinth API v2
Base `https://api.modrinth.com/v2`，**无需 key** ✅；必须设可识别 `User-Agent`；限流 **300 次/分钟/IP** ✅（`X-Ratelimit-Limit/Remaining/Reset`），缓存项目详情并全局限 2–3 req/s。

| Endpoint | 用途 |
|---|---|
| `GET /search?query=&facets=&index=&offset=&limit=` | 搜索（limit ≤100，默认 10） |
| `GET /project/{id\|slug}` | 项目详情（`loaders`、`game_versions`、`client_side`/`server_side`、`body`） |
| `GET /project/{id}/version?loaders=["fabric"]&game_versions=["1.20.1"]` | 版本列表（参数为 JSON 数组字符串，需 URL 编码） |
| `GET /version/{id}` | 版本详情（`files[].hashes`、`dependencies`） |
| `GET /version_file/{hash}?algorithm=sha1` | 本地 jar 哈希反查（✅ 200），用于去重 |
| `GET /projects?ids=["A","B"]` / `GET /versions?ids=[…]` | 批量（⚠️ 未逐个实测，格式同上） |
| `GET /tag/loader`、`/tag/game_version`、`/tag/category` | 筛选项 |
| `GET /project/{id}/dependencies` | 项目级依赖（⚠️ 未实测） |
facets 语法（✅ 实测 `[["project_type:mod"],["categories:fabric"],["versions:1.20.1"]]` → 39 hits）：外层 AND、内层 OR，元素 `type:value`；`type` ∈ `project_type`（`mod`/`modpack`/`resourcepack`/`shader`/`datapack`/`plugin`）、`categories`（`fabric`/`neoforge`/`optimization`…）、`versions`（单个版本号）、`client_side`/`server_side`。`index` ∈ `relevance`(默认)/`downloads`/`follows`/`newest`/`updated`（⚠️ 枚举名以文档为准）。
```json
// GET /search 响应（截断）
{"hits": [{"project_id": "AANobbMI", "slug": "sodium", "title": "Sodium", "project_type": "mod", "categories": ["fabric","neoforge","optimization","quilt"],
  "versions": ["1.16.3","…","1.21.11","26.3"], "client_side": "required", "server_side": "unsupported", "environment": ["client_only"],
  "downloads": 256303504, "latest_version": "OihdIimA", "icon_url": "https://cdn.modrinth.com/data/AANobbMI/…_96.webp"}],
 "offset": 0, "limit": 2, "total_hits": 39}
// GET /version/{id}（截断）
{"id": "OihdIimA", "project_id": "AANobbMI", "version_number": "mc1.20.1-0.5.13-fabric",
 "loaders": ["fabric","quilt"], "game_versions": ["1.20.1"], "version_type": "release",
 "dependencies": [{"version_id": "ryOMVRuG", "project_id": "AANobbMI", "file_name": null, "dependency_type": "required"}],
 "files": [{"hashes": {"sha1": "bcdbf37d…", "sha512": "81c64f9c…"}, "url": "https://cdn.modrinth.com/data/AANobbMI/versions/OihdIimA/sodium-fabric-0.5.13%2Bmc1.20.1.jar", "filename": "sodium-fabric-0.5.13+mc1.20.1.jar", "primary": true, "size": 971552}]}
```
- `dependency_type` ∈ `required`（✅ 实测）/`optional`/`incompatible`/`embedded`（⚠️ 后三种来自文档，样本未出现）。`version_id` 为空 = 只有项目级约束，需再查项目版本列表挑匹配 game/loader 的最新版。
- 装单个 Mod：匹配 `loaders` ∩ `game_versions` 的最新 `release`（可选 beta）→ 下载 `files[].url`（`primary` 优先）→ 校验 sha1/sha512 → 写 `mods/{filename}`；同 `project_id` 只留一个版本，filename 冲突加后缀不覆盖。
- `.mrpack` ✅：
```json
{"formatVersion": 1, "game": "minecraft", "name": "OptiMized", "versionId": "7.2.0",
 "dependencies": {"minecraft": "26.3", "fabric-loader": "0.19.5"},
 "files": [{"path": "mods/AsyncParticles-26.3.2.0+26.3.jar", "hashes": {"sha1": "a4213196…", "sha512": "c2eb9293…"},
            "env": {"client": "required", "server": "unsupported"}, "downloads": ["https://cdn.modrinth.com/data/c3onkd5k/versions/j1Ad4S3b/AsyncParticles-….jar"], "fileSize": 1299458}]}
```
  安装：解压 → 读 `modrinth.index.json` → 按 `dependencies` 装对应 loader（`fabric-loader` 等键名与 loader 同名）→ 逐 `files` 下载到 `<instance>/{path}`（校验 sha1）→ 纯客户端时跳过 `env.client=="unsupported"` → `overrides/` 覆盖到实例根（✅ 实测存在；`client-overrides/`、`server-overrides/` ❓ 未出现在样本，按文档支持）。
- 合规：CDN 无鉴权可直连，但带 UA、按项目 license 处理再分发（只下载不打包）。
**CurseForge**：Base `https://api.curseforge.com/v1` ✅；必须 `x-api-key`（✅ 文档），key 在 `console.curseforge.com` 申请（第三方启动器走审核表单）；`pageSize≤50`、`index+pageSize≤10000` ✅；作者可禁止第三方分发 → `downloadUrl` 可能 null ⚠️；大陆访问不稳。结论：P2 只接 Modrinth，CurseForge 留 P4（key 走 cloud 配置下发，不硬编码客户端）。
## 5. 模组冲突的静态判据
### 5.1 元数据字段
`fabric.mod.json`（jar 根，✅ Sodium 实测）：
```json
{"schemaVersion": 1, "id": "sodium", "version": "0.5.13+mc1.20.1", "environment": "client",
 "depends": {"minecraft": "1.20.1", "fabricloader": ">=0.12.0", "fabric-rendering-fluids-v1": ">=0.1"}, "breaks": {"optifabric": "*", "iris": "<1.7.6", "sodium-extra": "<0.5.4"},
 "mixins": [{"config": "sodium.mixins.json", "environment": "client"}],
 "jars": [{"file": "META-INF/jars/fabric-api-base-….jar"}], "accessWidener": "sodium.accesswidener"}
```

| 字段 | 冲突用途 |
|---|---|
| `id` | 重复 modid = 强冲突（Fabric 直接拒绝启动） |
| `version` | 版本比较（`depends`/`breaks` 求值） |
| `environment` | `client`/`server`/`*`；client-only 装进服务端实例 = 无效 |
| `depends` | 必需依赖（缺失即崩）；值为版本谓词 |
| `breaks` | "我破坏哪些 mod 的哪些版本"（✅ `iris:"<1.7.6"`）；需双向检查（A.breaks 命中 B 或 B.breaks 命中 A） |
| `conflicts` | ⚠️ 规范中与 `breaks` 并存但极少用，语义 = modid 不能共存；先按 breaks 处理，遇到再特判 |
| `mixins[]` | mixin 入口（字符串或 `{config, environment}`），配 §5.3 提取 targets |
| `jars[]` | 嵌套 jar（JiJ）：**必须递归**读其元数据，否则漏判内置旧版依赖冲突 |
| `accessWidener` | 同名文件冲突少见，记录不判 |
版本谓词（Maven 风格 + Fabric 扩展，⚠️ 需自实现解析）：`>=1.2`、`<1.20.1`、`1.20.1`（精确）、`*`、`~1.20`、`^0.5`；FML 的 `[1.0,2.0)` 区间也常见。比较前把版本号拆数字段；`26.3` 这类新版本号要能处理（别假定以 `1.` 开头）。
`META-INF/mods.toml`（Forge，✅ JEI 1.20.1）：
```toml
modLoader="javafml"
loaderVersion="[47,)"          # 与 Forge 主版本对应；不符=强冲突
[[mods]]
modId="jei"
version="15.74.0.232"
displayName="Just Enough Items"
[[dependencies.jei]]
    modId="minecraft"
    mandatory=true             # NeoForge 1.20.5+ 改为 type="required" ✅
    versionRange="[1.20.1, 1.20.2)"
    ordering="NONE"            # BEFORE/AFTER/NONE
    side="BOTH"                # BOTH/CLIENT/SERVER
```
`META-INF/neoforge.mods.toml`（NeoForge 1.20.5+，✅ JEI 1.21.1）：字段同 mods.toml，文件名不同、依赖用 `type="required"`（`mandatory` 废弃）、有 `displayTest="IGNORE_SERVER_VERSION"` ✅。Forge 1.20.5+ 也支持 `type`（⚠️ 以实测为准）。用 TOML 解析器（不要正则），注意重复 `[[dependencies.<modid>]]` 表。
`quilt.mod.json`（⚠️ 未实测）：`{"schemaVersion":1,"quilt_loader":{"group","id","version","metadata","depends","provides","breaks"},"mixin":[…],"entrypoints":{…}}`；多数 Quilt mod 同时带 fabric.mod.json，P2 不解析、回退读后者。
### 5.2 mixin 配置文件结构 ✅（Sodium）
```json
{"package": "me.jellysquid.mods.sodium.mixin", "required": true, "compatibilityLevel": "JAVA_17", "plugin": "me.jellysquid.mods.sodium.mixin.SodiumMixinPlugin",
 "injectors": {"defaultRequire": 1}, "overwrites": {"conformVisibility": true},
 "client": ["core.MinecraftClientMixin", "features.render.world.WorldRendererMixin", "…"]}
```
顶层数组：`mixins`（通用）、`client`、`server`；类名相对 `package`。
### 5.3 mixin targets 提取（三级）
1. **只读配置（P2 基线）**：拿到 mixin 类名 + `package`，只能判"同名配置/同 package"（弱）。
2. **读 class 常量池（推荐，P3）**：`@Mixin(targets={"net.minecraft.client.MinecraftClient"})` 的字符串就在 `.class` 常量池；用轻量 classfile 解析（读 `CONSTANT_Utf8`）抽类名/`net/minecraft/` 字符串，混淆名需再查映射（⚠️ 生产环境 intermediary/官方映射有差异）。targets 也可能由 mixin `plugin` 动态注入（Sodium 即如此）→ 静态不可知，标记"动态"。
3. **近似 grep**：扫 jar 内所有 class 的 `net/minecraft/` 字符串（误报多，仅提示）。
判据强度：**同 target ≠ 冲突**（几十个 mod 都 mixin `MinecraftClient`）；真正判据是"同 target + 同方法/注入点 + 覆盖重叠"，静态难准确。P3 只输出"共享 target 数 top N + 可疑组合"给 AI 归因，**不阻断启动**。
### 5.4 判据汇总（按强度降序）

| 判据 | 来源 | 强度 | 误报 |
|---|---|---|---|
| 两 jar 同 `id`/`modId` | fabric.mod.json / mods.toml / neoforge.mods.toml | 强（必崩） | 低（JiJ 嵌套 jar 注意排除/递归） |
| 必需依赖缺失 | 同上 | 强 | 低（`minecraft`/`forge`/`fabricloader` 视为已满足） |
| `breaks`/`versionRange` 命中 | fabric breaks；FML versionRange | 强 | 中（版本谓词解析错会误报） |
| loader 不匹配（Fabric jar 放 Forge 实例） | jar 元数据文件名 + `modLoader` | 强 | 低 |
| Java 主版本低于要求 | fabric `depends.java`；class major（52=8/61=17/65=21）⚠️ | 中 | 低 |
| `environment`/`side` 冲突 | fabric environment；FML side | 中 | 中（大量 mod 声明 `*`） |
| 同 mixin target | 常量池扫描 | 弱 | 高 |
| 原版资源同名覆盖 | resource pack 顺序 | 忽略 | — |
## 6. 版本隔离的目录布局建议
### 6.1 推荐布局（`D:\QDOQMC` 为数据根）
```
<data>/
  assets/{indexes/, objects/, virtual/{legacy,pre-1.6}/}        # 全局共享（只读）
  libraries/  runtimes/{component}/{version}/bin/javaw.exe        # 全局共享（Maven 布局 / 按 component 隔离）
  meta/{version_manifest_v2.json, asset_indexes/<id>.json, versions/<id>.json, loaders/…}   # 官方 JSON 原始缓存
  versions/<id>/{<id>.json, <id>.jar, natives/}                  # 原版/加载器版本（jar 仅原版有）
  instances/<slug>/instance.json + .minecraft/                   # 实例：mc_version/loader/java/memory/icon…
      mods/ config/ saves/ logs/ crash-reports/ options.txt servers.dat resourcepacks/ shaderpacks/
  shared/{resourcepacks/,shaderpacks/,datapacks/}                # 可选：跨实例共享包
  cache/downloads/<sha1前缀>/<sha1>                              # 内容寻址缓存（硬链接源）
  logs/{launcher.log, events.jsonl, game-<ts>.log}
```
### 6.2 共享 vs 隔离

| 目录/文件 | 处置 | 理由 |
|---|---|---|
| `assets/`、`libraries/`、`runtimes/`、`versions/<id>/`（原版） | 共享 | 只读、体积大、多实例复用 |
| `mods/`、`config/`、`defaultconfigs/`、`kubejs/` | 隔离 | mod 集合/配置与整合包强相关 |
| `saves/`、`options.txt`、`servers.dat`、`usercache.json` | 隔离 | 玩家数据/按键/服务器列表 |
| `resourcepacks/`、`shaderpacks/` | 隔离（可 junction 共享包库） | 包组合与加载器相关，用户常混装 |
| `logs/`、`crash-reports/`、`screenshots/`、`stats/`、`advancements/` | 隔离 | 归因/数据必须按实例 |
### 6.3 HMCL / PCL2 / Prism 对照（⚠️ 公开行为总结，细节以实测为准）

| 启动器 | 实例位置 | 共享区 | 借鉴点 |
|---|---|---|---|
| HMCL | `.minecraft/versions/<id>/` 内放 mods/config/saves（版本隔离） | `.minecraft/{assets,libraries}` | 布局简单、可被官方启动器识别 |
| PCL2 | `.minecraft/versions/<name>/` | `assets/libraries` | 实例=版本目录，迁移简单 |
| Prism | `<root>/instances/<name>/.minecraft/` + `instance.cfg` + `mmc-pack.json` | `<root>/{libraries,assets,java}`，可链接共享资源 | **与目标最接近**：根共享 + 实例 `.minecraft` + 元数据 JSON |
推荐：采用 Prism 式（实例独立 `.minecraft` + 根共享 + `instance.json`），同时保留 `versions/` 给"未隔离的全局版本"，兼容官方/HMCL 用户迁移。
### 6.4 硬链接 / 符号链接的坑（Windows 必读）
1. **同卷**：NTFS 硬链接只能同卷；实例移到其他盘会失败，捕获 `EXDEV`/`EPERM` 回退复制。
2. **原地写污染**：硬链接同一 inode，缓存 jar 绝不能原地修改；更新一律"新文件 → rename 覆盖"（rename 后旧链接仍指旧 inode，安全）。
3. **删除安全但统计不准**：删实例不释放缓存（正确），资源管理器显示重复占用；用 `fs.stat.nlink` 估算真实占用。
4. **文件系统限制**：FAT32/exFAT（U 盘）、SMB 网络盘不支持硬链接 → 复制。
5. **目录不能硬链接**：用 junction（`mklink /J` 或 `fs.symlink(target, path, 'junction')`，**无需管理员**）。
6. **符号链接需特权**：Windows 下需管理员或"开发者模式"；不要默认依赖，失败回退 junction/复制。
7. **文件占用**：游戏运行时 Java 打开 `mods/*.jar`、`libraries/*.jar`，替换/删除报 `EBUSY`/`EPERM` → 更新前检测实例进程。
8. **安全软件/同步盘**：可能不识别硬链接，重复扫描/上传；备份按 inode 去重。
9. **损坏连带**：硬链接共享内容，缓存损坏则所有实例坏 → 校验失败删缓存条目并重建链接。
10. **长路径**：mods 文件名+实例路径易超 260 字符；启用 `LongPathsEnabled` 或 `\\?\` 前缀（Node fs 支持），UI 限制实例名长度。
11. **不要对 `options.txt`/`saves` 用硬链接**：游戏原地重写，一改全改。
12. **同 modid 多文件**：加载顺序按文件名/扫描顺序（FML 字典序 ⚠️），冲突判据应报"同 modid 多文件"而非赌排序。
## 7. P1 最小实现清单（按依赖顺序，14 步 ≈ 3 周）
1. **数据根与路径模块**：目录布局（§6）、路径/URL 工具、Maven 坐标↔路径、实例 `instance.json` schema。
2. **下载器**：队列 + 断点续传 + sha1/size 校验 + 原子 rename + 重试/镜像回退 → `download_tasks` 表。
3. **Manifest 服务**：拉 `version_manifest_v2.json`、缓存过期策略、按 type 分组给 UI。
4. **Version 解析器**：下载/校验单版本 json、全节点解析、`inheritsFrom` 递归合并去重、Maven 库解析。
5. **原版安装**：client jar + libraries（rules 过滤）+ logging 配置 + assetIndex → `versions/<id>/`。
6. **Assets 安装**：objects 下载到 `assets/objects`；legacy/pre-1.6 物化（§1.4），可断点续跑。
7. **Java 探测与匹配**：常见路径/注册表/PATH 扫描 + `java -version` 解析；按 `javaVersion.majorVersion` 选；失败给"手动指定"入口。
8. **Java 运行时下载**：`all.json` → 组件 manifest → 解包 `files` → 校验可执行路径。
9. **参数组装器**：rules 求值、占位符替换、双格式支持、加载器参数追加、`-cp` 拼接与长度检查。
10. **natives 策略**：三代判定（§2.2）、解压/清理/校验。
11. **进程管理**：spawn（cwd/env/windowsHide）、字节流 UTF-8→GBK 回退、日志双写、退出码归因、停止/强杀、单实例锁、崩溃文件扫描。
12. **离线登录**：玩家名校验、离线 UUID v3、token 占位、`--userType legacy`、可读错误。
13. **端到端自测矩阵**：`1.6.4`（legacy assets+老参数）、`1.12.2`（minecraftArguments）、`1.20.1`（arguments+Java17+新 natives）、最新 release（Java21+新索引）各跑通一次。
14. **观测**：`events.jsonl` 记录 install/launch/exit/crash（耗时、下载字节、失败码），供 P3 归因与统计复用。
P2 衔接：Fabric 合并（§3.1）→ Modrinth 搜索/安装（§4）→ NeoForge processors（§3.2）→ 冲突预检（§5 弱判据）→ `.mrpack`；Forge 单独攻坚放 P2 末尾。
## 8. 未验证 / 待实测清单
1. ❓ Forge 1.20.1+ patched client jar 是否必须显式加入版本 `libraries`（§3.2）——解包 `bootstraplauncher` 或对照 HMCL/Prism 产物定论。
2. ❓ `${game_assets}` 在 1.6.x / ≤1.5.2 的确切取值（virtual 目录 vs assets 根）。
3. ❓ `old_alpha`/`old_beta` 的 assets 与参数特例。
4. ⚠️ Modrinth `index` 枚举名、`projects?ids=` 批量、`/project/{id}/dependencies` 行为。
5. ⚠️ `dependency_type` 的 optional/incompatible/embedded 实际语义与嵌套依赖处理。
6. ⚠️ `fs.symlink(…, 'junction')` 在目标 Electron/Node 的行为；`TextDecoder('gbk')` 打包后是否可用。
7. ⚠️ processors 对 Java 版本要求（1.20.1=17、1.21.1=21、1.12.2=8）以实测为准。
8. ⚠️ HMCL/PCL2/Prism 目录细节（§6.3）以本机实例为准。
9. ❓ Quilt `quilt.mod.json` 字段与启动参数额外要求。
10. ⚠️ 大陆各域名可用性与镜像路径规则，建议 P1 后期多运营商抽测。
