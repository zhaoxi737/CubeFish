"""方块鱼手机版 M6：给手机 AI 补齐一批和桌面版对应的工具。

新增工具（AI 可调用）：
  plan / search_mods / install_mod / list_versions / select_version / read_crash / open_game_folder
桌面版独有的（改源码、跑 PowerShell、写插件、子助手）在 Android 上不适用，会在系统提示里说明。
"""
from pathlib import Path

BRIDGE = Path(
    r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\dev\cubefish\mobile\ai\AiBridge.java"
)
INDEX = Path(
    r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\ai\index.html"
)


def patch_bridge() -> None:
    text = BRIDGE.read_text(encoding="utf-8")

    if 'case "search_mods"' not in text:
        old_cases = '''                case "list_mods":
                    return listMods();
                case "launch_game":
                    return launchGame();'''
        new_cases = '''                case "list_mods":
                    return listMods();
                case "search_mods":
                    return searchModsTool(args);
                case "install_mod":
                    return installModTool(args);
                case "list_versions":
                    return listVersionsTool();
                case "select_version":
                    return selectVersionTool(args);
                case "read_crash":
                    return readCrashTool();
                case "open_game_folder":
                    return openGameFolderTool();
                case "plan":
                    return planTool(args);
                case "launch_game":
                    return launchGame();'''
        assert old_cases in text, "runTool switch anchor not found"
        text = text.replace(old_cases, new_cases, 1)

    anchor = "    /* ---------- 模型对话 ---------- */"
    assert anchor in text, "chat section anchor not found"
    helpers = '''    /* ---------- 和桌面版对齐的额外工具 ---------- */

    private String searchModsTool(JSONObject args) {
        String query = args.optString("query", "").trim();
        if (query.isEmpty()) return err("请给个关键词，例如 sodium / jei / 小地图");
        try {
            JSONObject result = ModBrowser.search(query, ModBrowser.target());
            JSONArray hits = result.optJSONArray("hits");
            if (hits == null || hits.length() == 0) {
                return ok("没搜到「" + query + "」（当前版本 " + result.optString("mcVersion") + " / " + result.optString("loader") + "）");
            }
            StringBuilder sb = new StringBuilder("搜索「" + query + "」（" + result.optString("mcVersion") + " / " + result.optString("loader") + "）：");
            for (int i = 0; i < Math.min(hits.length(), 8); i++) {
                JSONObject hit = hits.getJSONObject(i);
                sb.append("\\n· ").append(hit.optString("title"))
                        .append("（projectId=").append(hit.optString("id")).append("）")
                        .append(hit.optString("description"));
            }
            sb.append("\\n要装的话调 install_mod（可以直接给 query）。");
            return ok(sb.toString());
        } catch (Exception error) {
            return err("搜索模组失败：" + error.getMessage());
        }
    }

    private String installModTool(JSONObject args) {
        String projectId = args.optString("projectId", "").trim();
        String query = args.optString("query", "").trim();
        if (projectId.isEmpty() && query.isEmpty()) return err("需要 query（模组名）或 projectId");
        try {
            ModBrowser.Target target = ModBrowser.target();
            if (projectId.isEmpty()) {
                JSONObject result = ModBrowser.search(query, target);
                JSONArray hits = result.optJSONArray("hits");
                if (hits == null || hits.length() == 0) return err("没搜到「" + query + "」，换个关键词");
                projectId = hits.getJSONObject(0).optString("id");
            }
            String summary = ModBrowser.install(target, projectId);
            return ok(summary + "\\n（装完回主界面启动游戏生效；目标版本 " + target.mcVersion + " / " + target.loader + "）");
        } catch (Exception error) {
            return err("安装失败：" + error.getMessage());
        }
    }

    private String listVersionsTool() {
        try {
            File dir = new File(Tools.DIR_HOME_VERSION);
            File[] children = dir.listFiles();
            java.util.ArrayList<String> ready = new java.util.ArrayList<>();
            java.util.ArrayList<String> partial = new java.util.ArrayList<>();
            if (children != null) {
                for (File child : children) {
                    if (!child.isDirectory()) continue;
                    String name = child.getName();
                    if (new File(child, name + ".json").exists()) ready.add(name);
                    else partial.add(name);
                }
            }
            java.util.Collections.sort(ready);
            java.util.Collections.sort(partial);
            String current = "";
            try {
                current = LauncherProfiles.getCurrentProfile().lastVersionId;
            } catch (Throwable ignored) {
            }
            StringBuilder sb = new StringBuilder("本机版本（当前选中：" + (current.isEmpty() ? "未知" : current) + "）：");
            if (ready.isEmpty() && partial.isEmpty()) sb.append("\\n还没有下载任何版本：先在主界面版本栏创建并下载一个");
            for (String name : ready) sb.append("\\n✓ ").append(name).append(name.equals(current) ? "（当前）" : "");
            for (String name : partial) sb.append("\\n… ").append(name).append("（未下载完）");
            return ok(sb.toString());
        } catch (Exception error) {
            return err("读取版本失败：" + error.getMessage());
        }
    }

    private String selectVersionTool(JSONObject args) {
        String versionId = args.optString("versionId", "").trim();
        if (versionId.isEmpty()) return err("需要 versionId，例如 1.20.1");
        try {
            File json = new File(Tools.DIR_HOME_VERSION + "/" + versionId + "/" + versionId + ".json");
            if (!json.exists()) {
                return err("本机没有 " + versionId + " 的版本文件：先用主界面版本栏下载它，或用 list_versions 看已有哪些");
            }
            LauncherProfiles.load();
            MinecraftProfile profile = MinecraftProfile.createTemplate();
            profile.name = versionId;
            profile.lastVersionId = versionId;
            String key = LauncherProfiles.getFreeProfileKey();
            LauncherProfiles.mainProfileJson.profiles.put(key, profile);
            LauncherProfiles.write();
            android.preference.PreferenceManager.getDefaultSharedPreferences(activity)
                    .edit().putString(LauncherPreferences.PREF_KEY_CURRENT_PROFILE, key).apply();
            return ok("已切换到版本 " + versionId + "（回主界面点「启动游戏」即可）");
        } catch (Exception error) {
            return err("切换版本失败：" + error.getMessage());
        }
    }

    private String readCrashTool() {
        try {
            ModBrowser.Target target = ModBrowser.target();
            File folder = new File(target.gameDir, "crash-reports");
            File[] files = folder.listFiles();
            if (files == null || files.length == 0) return ok("没有崩溃报告（crash-reports 目录是空的）");
            File newest = null;
            for (File file : files) {
                if (!file.isFile()) continue;
                if (newest == null || file.lastModified() > newest.lastModified()) newest = file;
            }
            if (newest == null) return ok("没有崩溃报告");
            java.io.BufferedReader reader = new java.io.BufferedReader(
                    new java.io.InputStreamReader(new java.io.FileInputStream(newest), java.nio.charset.StandardCharsets.UTF_8));
            java.util.ArrayList<String> lines = new java.util.ArrayList<>();
            String line;
            while ((line = reader.readLine()) != null) {
                lines.add(redact(line));
                if (lines.size() > 300) lines.remove(0);
            }
            reader.close();
            StringBuilder sb = new StringBuilder("最新崩溃报告（" + newest.getName() + "，已脱敏）：");
            int from = Math.max(0, lines.size() - 80);
            for (int i = from; i < lines.size(); i++) sb.append("\\n").append(lines.get(i));
            return ok(sb.toString());
        } catch (Exception error) {
            return err("读取崩溃报告失败：" + error.getMessage());
        }
    }

    private String openGameFolderTool() {
        try {
            ModBrowser.Target target = ModBrowser.target();
            final File dir = target.gameDir;
            activity.runOnUiThread(() -> {
                try {
                    Tools.openPath(activity, dir, false);
                } catch (Throwable ignored) {
                }
            });
            return ok("正在打开游戏目录：" + dir.getAbsolutePath());
        } catch (Exception error) {
            return err("打开目录失败：" + error.getMessage());
        }
    }

    private String planTool(JSONObject args) {
        JSONArray steps = args.optJSONArray("steps");
        if (steps == null || steps.length() == 0) return ok("计划已记录（空计划）");
        StringBuilder sb = new StringBuilder("计划（" + steps.length() + " 步）：");
        for (int i = 0; i < steps.length(); i++) sb.append("\\n").append(i + 1).append(". ").append(steps.optString(i));
        return ok(sb.toString());
    }

'''
    text = text.replace(anchor, helpers + anchor, 1)

    # 需要 Collections 排序
    if "import java.util.Collections;" not in text:
        text = text.replace("import java.util.ArrayList;", "import java.util.ArrayList;\nimport java.util.Collections;", 1)

    BRIDGE.write_text(text, encoding="utf-8")
    print("AiBridge 已更新：新增 7 个工具")


def patch_index() -> None:
    text = INDEX.read_text(encoding="utf-8")

    if "'search_mods'" not in text:
        old_tools_anchor = """    { type: 'function', function: { name: 'launch_game', description: '启动当前选中的 Minecraft 版本。', parameters: { type: 'object', properties: {} } } },
  ];"""
        new_tools = """    { type: 'function', function: { name: 'launch_game', description: '启动当前选中的 Minecraft 版本。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'search_mods', description: '在 Modrinth 搜模组（按当前游戏版本+加载器筛选）。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'install_mod', description: '安装模组到当前版本（自动带必需前置）。给 query 或 projectId。', parameters: { type: 'object', properties: { query: { type: 'string' }, projectId: { type: 'string' } } } } },
    { type: 'function', function: { name: 'list_versions', description: '列出本机已下载/未下载完的 Minecraft 版本。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'select_version', description: '把某个已下载的版本设为当前版本。', parameters: { type: 'object', properties: { versionId: { type: 'string' } }, required: ['versionId'] } } },
    { type: 'function', function: { name: 'read_crash', description: '读取最新崩溃报告（已脱敏）。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'open_game_folder', description: '打开当前版本的游戏文件夹（模组/存档所在）。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'plan', description: '多步任务先列计划。', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
  ];"""
        assert old_tools_anchor in text, "TOOLS anchor not found"
        text = text.replace(old_tools_anchor, new_tools, 1)

    old_prompt = "'5. 你只有这些工具：get_status / read_log / set_memory / list_mods / launch_game。',\n    '   不能装模组、不能改游戏文件、不能联网搜索；用户要这些能力时，明确说手机版还没做，并给出手动做法。',"
    new_prompt = "'5. 你的工具：get_status / read_log / read_crash / set_memory / list_mods / search_mods / install_mod / list_versions / select_version / open_game_folder / launch_game / plan。',\n    '   装模组用 search_mods 找 → install_mod 装（自动带前置）。',\n    '   手机版没有的能力：改启动器源码、跑系统命令、写插件、子助手、随便联网搜网页。用户要这些时明确说手机版没有，并给替代做法。',"
    if old_prompt in text:
        text = text.replace(old_prompt, new_prompt, 1)

    old_welcome = "我是方块鱼手机版的助手。现在能动的东西：\\n· 看设备/版本/内存/模组数\\n· 读最近一次游戏日志（已脱敏）\\n· 改内存分配\\n· 启动游戏\\n\\n装模组、修冲突还在做（桌面版已经有）。"
    new_welcome = "我是方块鱼手机版的助手，能直接操作启动器：\\n· 看设备/版本/内存/模组数、读日志和崩溃报告\\n· 改内存、切换版本\\n· 搜模组并安装（自动带前置）\\n· 打开游戏文件夹、启动游戏\\n\\n说人话就行，比如「装个 sodium」「为什么崩了」「内存调到 8G」。"
    if old_welcome in text:
        text = text.replace(old_welcome, new_welcome, 1)

    INDEX.write_text(text, encoding="utf-8")
    print("index.html 已更新：工具清单 + 系统提示 + 欢迎语")


if __name__ == "__main__":
    patch_bridge()
    patch_index()
