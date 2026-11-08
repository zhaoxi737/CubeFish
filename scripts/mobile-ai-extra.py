"""方块鱼手机版 M7：把「冲突检查/修复、联网搜索、整合包安装」接进 AI 工具。

改动：
1. ModBrowser.download 改成包内可见（ModpackInstaller 复用）
2. AiBridge 增加 5 个工具：check_mod_conflicts / fix_mod_conflicts / web_search / web_fetch / install_modpack
3. index.html 工具清单 + 系统提示同步
"""
from pathlib import Path

BROWSER = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\dev\cubefish\mobile\ai\ModBrowser.java")
BRIDGE = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\dev\cubefish\mobile\ai\AiBridge.java")
INDEX = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\ai\index.html")


def patch_browser():
    text = BROWSER.read_text(encoding="utf-8")
    if "    static void download(" in text:
        print("ModBrowser 已可复用")
        return
    text = text.replace("    private static void download(", "    static void download(", 1)
    BROWSER.write_text(text, encoding="utf-8")
    print("ModBrowser.download 改为包内可见")


def patch_bridge():
    text = BRIDGE.read_text(encoding="utf-8")
    if 'case "check_mod_conflicts"' in text:
        print("AiBridge 已包含新工具")
        return
    anchor = '''                case "plan":
                    return planTool(args);'''
    assert anchor in text
    new_cases = '''                case "plan":
                    return planTool(args);
                case "check_mod_conflicts":
                    return ok(ModConflicts.analyze(ModBrowser.target()));
                case "fix_mod_conflicts":
                    return ok(ModConflicts.fix(ModBrowser.target()));
                case "web_search":
                    return ok(WebTools.search(args.optString("query", "")));
                case "web_fetch":
                    return ok(WebTools.fetch(args.optString("url", "")));
                case "install_modpack":
                    return installModpackTool(args);'''
    text = text.replace(anchor, new_cases, 1)

    helper_anchor = "    /* ---------- 和桌面版对齐的额外工具 ---------- */"
    assert helper_anchor in text
    helper = '''    private String installModpackTool(JSONObject args) {
        String path = args.optString("path", "").trim();
        if (path.isEmpty()) return err("需要 .mrpack 文件路径，例如 /sdcard/Download/xxx.mrpack");
        File file = new File(path);
        if (!file.isFile()) return err("找不到文件：" + path);
        try {
            return ok(ModpackInstaller.install(file, ModBrowser.target()));
        } catch (Exception error) {
            return err("安装整合包失败：" + error.getMessage());
        }
    }

'''
    text = text.replace(helper_anchor, helper + helper_anchor, 1)
    BRIDGE.write_text(text, encoding="utf-8")
    print("AiBridge 已加 5 个工具")


def patch_index():
    text = INDEX.read_text(encoding="utf-8")
    if "'check_mod_conflicts'" in text:
        print("index.html 已包含新工具")
        return
    anchor = """    { type: 'function', function: { name: 'plan', description: '多步任务先列计划。', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
  ];"""
    new = """    { type: 'function', function: { name: 'plan', description: '多步任务先列计划。', parameters: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] } } },
    { type: 'function', function: { name: 'check_mod_conflicts', description: '检查模组冲突：重复 mod、缺前置、游戏版本不匹配。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'fix_mod_conflicts', description: '一键修复模组冲突：删重复旧 jar、用 Modrinth 装缺失前置。', parameters: { type: 'object', properties: {} } } },
    { type: 'function', function: { name: 'web_search', description: '联网搜索（中文走搜狗，其它走 Bing），返回标题和链接。', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } },
    { type: 'function', function: { name: 'web_fetch', description: '抓网页正文（只允许 https，HTML 转纯文本）。', parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } } },
    { type: 'function', function: { name: 'install_modpack', description: '安装 Modrinth 整合包 .mrpack（需要本机文件路径）。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } } },
  ];"""
    assert anchor in text, "TOOLS anchor missing"
    text = text.replace(anchor, new, 1)

    old_prompt = "'   手机版没有的能力：改启动器源码、跑系统命令、写插件、子助手、随便联网搜网页。用户要这些时明确说手机版没有，并给替代做法。',"
    new_prompt = "'   冲突排查用 check_mod_conflicts，能修就调 fix_mod_conflicts（需要联网装前置）。',\n    '   查资料用 web_search → web_fetch。整合包 .mrpack 用 install_modpack（用户得先告出文件路径，或提示放 /sdcard/Download）。',\n    '   手机版没有的能力：改启动器源码、跑系统命令、写插件、子助手。用户要这些时明确说手机版没有，并给替代做法。',"
    if old_prompt in text:
        text = text.replace(old_prompt, new_prompt, 1)
    INDEX.write_text(text, encoding="utf-8")
    print("index.html 已加工具清单 + 提示")


if __name__ == "__main__":
    patch_browser()
    patch_bridge()
    patch_index()
