# 插件开发指南（P5）

> 插件把新能力装进启动器，同时也能被 AI 助手调用——这就是「AI 给启动器加功能」的落地方式。

## 1. 插件长什么样

目录结构：

```
%APPDATA%\QDOQMC\plugins\<插件 id>\
├── plugin.json     # 清单
└── index.mjs       # 入口（ESM）
```

`plugin.json`：

```json
{
  "id": "hello-world",
  "name": "示例：你好世界",
  "version": "1.0.0",
  "apiVersion": 1,
  "main": "index.mjs",
  "description": "演示插件：注册聊天命令 + AI 工具",
  "author": "QDOQMC",
  "permissions": []
}
```

- `id`：小写字母开头，允许 `a-z0-9._-`，必须与目录名一致（建议）。
- `apiVersion`：当前只支持 `1`，更高版本会被拒绝加载。
- `permissions`：`"read"`（读文件）/ `"net"`（联网）/ `"exec"`（执行代码）。**当前权限是提示性的，不是沙箱**，见第 5 节。

## 2. 入口约定

`index.mjs` 必须导出 `apply(api)`；可以返回一个清理函数，禁用插件时会被调用：

```js
export function apply(api) {
  api.registerCommand({
    name: 'hello',
    description: '示例命令',
    async run() {
      return '你好！'
    },
  })

  api.registerTool({
    name: 'plugin_hello',
    description: '示例工具：向某人问好',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string' } },
      additionalProperties: false,
    },
    async handler(args) {
      return { ok: true, summary: `你好，${args?.name || '世界'}！` }
    },
  })

  api.log.info('插件已加载')
  return () => api.log.info('插件已卸载')
}
```

## 3. `api` 表面

| API | 说明 |
|---|---|
| `api.plugin` | `{ id, version }` |
| `api.version` | 宿主 API 版本（当前 `"1"`） |
| `api.permissions` | 清单里声明的权限数组 |
| `api.log.info/warn/error(msg)` | 写进启动器结构化日志，scope 为 `plugin:<id>` |
| `api.registerTool(def)` | 注册 AI 工具；`def.parameters` 是 JSON Schema |
| `api.registerCommand(spec)` | 注册聊天命令（`/name`） |
| `api.callTool(name, args)` | 调用内置工具（如 `search_mods`、`launch_game`） |
| `api.storage.get/set(key, value)` | 按插件 id 命名空间持久化（JSON） |

可用内置工具名：`get_status` `search_mods` `install_mod` `list_mods` `analyze_conflicts` `diagnose_crash` `read_game_log` `launch_game` `stop_game` `install_version` `install_fabric` `set_memory`。

## 4. 安全模型（重要）

- 插件默认**不启用**，必须在「插件」面板点「启用」（或在 CLI 用 `--enable-plugin=<id>`）；
- 启用即授权：插件会在**主进程内运行**，拥有 Node 全部能力；
- 禁用会撤回它注册的所有工具/命令，并调用返回的清理函数；
- 每次加载/卸载/工具调用都会写 `events.jsonl` 与结构化日志，便于审计。

**真正的沙箱**（utilityProcess + RPC + fs/net 代理）是后续工作，现阶段请只安装你信任来源的插件。

## 5. 命令行

```bash
electron . --plugins                    # 列出插件及状态
electron . --enable-plugin=hello-world  # 启用（授权 + 加载）
electron . --disable-plugin=hello-world # 禁用（卸载 + 撤回注册）
electron . --tools                      # 查看当前所有可被模型调用的工具
```

## 6. 示例

仓库里自带：`samples/plugins/hello-world/`（注册 `/hello` 命令 + `plugin_hello` 工具 + 存储计数）。

复制到 `%APPDATA%\QDOQMC\plugins\hello-world` 后刷新「插件」面板即可看到。

## 7. 插件市场（P9）

启动器内置一个**静态 feed** 市场：你在自己的 CDN 放 `market.json`，客户端配置地址后即可看到插件列表并一键安装。

### 7.1 feed 格式

```json
{
  "format": "qdoqmc-market/1",
  "payload": "<base64(JSON)>",
  "signature": "<base64(Ed25519(payload bytes))>"
}
```

`payload` 解码后：

```json
{
  "generatedAt": "2026-10-29T00:00:00.000Z",
  "plugins": [
    {
      "id": "hello-world",
      "name": "示例：你好世界",
      "version": "1.0.0",
      "description": "…",
      "author": "QDOQMC",
      "permissions": [],
      "download": {
        "url": "https://cdn.example.com/qdoqmc/market/hello-world-1.0.0.zip",
        "sha256": "…",
        "size": 1182
      }
    }
  ]
}
```

### 7.2 生成与签名

```bash
# 开发：自动生成密钥对，产物在 dist/market/
node scripts/make-market.mjs samples/plugins/hello-world http://127.0.0.1:18083
# → dist/market.json、dist/market/hello-world-1.0.0.zip、dist/market/dev-{public,private}.pem

# 生产：用你自己的私钥（只把公钥给用户）
$env:QDOQMC_MARKET_PRIVKEY='C:\keys\market-key.pem'
$env:QDOQMC_MARKET_PUBKEY_PEM='C:\keys\market-key.pub.pem'
node scripts/make-market.mjs <插件目录> https://cdn.example.com/qdoqmc
```

把 `dev-public.pem` 填到启动器「设置 → 市场公钥」，把 `market.json` 和插件 zip 上传到 CDN 即可。

### 7.3 安全模型

- 配置了公钥 → **强制验签**，签名不符直接拒绝；
- 每个插件包还校验 **sha256 + 大小**，不一致拒绝安装；
- 解压防路径穿越；缺少 `plugin.json` 会回滚；
- 安装后仍需在「本地插件」里**手动启用**（启用 = 授权执行代码）。
