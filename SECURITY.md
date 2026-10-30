# 安全说明 / SECURITY

## 报告漏洞

请**不要**公开提 Issue。用 GitHub 的 [Security Advisories](https://github.com/zhaoxi737/CubeFish/security/advisories/new) 私密报告，或发我邮箱（见 GitHub 主页）。

我会尽快回复，确认后修复并在 Release 说明里致谢（除非你要求匿名）。

## 关于 AI 权限

启动器的 AI 助手默认只能操作启动器内部（装模组、改设置、写插件）。

以下能力**默认关闭**，需要用户在「设置 → AI 助手」里显式开启，且开启时有风险确认：

- `run_shell`：执行任意 PowerShell 命令
- `write_source_file` / `rebuild_launcher`：修改启动器源码并重新构建
- `rollback_source`：回滚源码

开启后 AI 拥有等同于当前用户权限的系统操作能力。**只在你信任模型与提示词的情况下开启。**

## 密钥与隐私

- API Key 只保存在本机 `%APPDATA%\QDOQMC\settings.json`，不会上传
- 聊天记录落盘前会自动把 `sk-...` 等密钥打码
- 崩溃日志里的密钥同样会被打码
- 如果怀疑 Key 泄露：立刻到服务商后台吊销重建

## 插件信任

插件运行在独立进程里，但**不是**完全的能力沙箱（插件仍能访问网络与文件）。
安装第三方插件前请确认来源可信；插件默认「未授权」，需要你手动启用。
