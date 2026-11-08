"""方块鱼手机版 M7.1：模组页加「导入 .mrpack 整合包」按钮（文件选择器 + 后台安装）。"""
from pathlib import Path

ACTIVITY = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\dev\cubefish\mobile\ai\AiChatActivity.java")
BRIDGE = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\dev\cubefish\mobile\ai\AiBridge.java")
MODS = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\ai\mods.html")


def patch_activity():
    text = ACTIVITY.read_text(encoding="utf-8")
    if "pickModpackFile" in text:
        print("AiChatActivity 已有导入逻辑")
        return
    text = text.replace(
        "    /** 打开时指定要显示的本地页面（默认聊天页，也可以传 guide.html 显示中文使用说明） */\n    public static final String EXTRA_PAGE = \"cubeFishPage\";",
        "    /** 打开时指定要显示的本地页面（默认聊天页，也可以传 guide.html 显示中文使用说明） */\n"
        "    public static final String EXTRA_PAGE = \"cubeFishPage\";\n\n"
        "    private static final int REQ_PICK_MODPACK = 4321;\n\n"
        "    /** 让用户挑一个 .mrpack 文件，挑完在后台装 */\n"
        "    public void pickModpackFile() {\n"
        "        try {\n"
        "            android.content.Intent intent = new android.content.Intent(android.content.Intent.ACTION_OPEN_DOCUMENT);\n"
        "            intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);\n"
        "            intent.setType(\"*/*\");\n"
        "            startActivityForResult(intent, REQ_PICK_MODPACK);\n"
        "        } catch (Throwable error) {\n"
        "            publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"error\\\",\\\"message\\\":\\\"无法打开文件选择器\\\"}\");\n"
        "        }\n"
        "    }\n\n"
        "    private void publish(String json) {\n"
        "        if (bridge != null) bridge.publishEvent(json);\n"
        "    }\n\n"
        "    @Override\n"
        "    protected void onActivityResult(int requestCode, int resultCode, android.content.Intent data) {\n"
        "        super.onActivityResult(requestCode, resultCode, data);\n"
        "        if (requestCode != REQ_PICK_MODPACK) return;\n"
        "        if (resultCode != RESULT_OK || data == null || data.getData() == null) {\n"
        "            publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"cancelled\\\"}\");\n"
        "            return;\n"
        "        }\n"
        "        final android.net.Uri uri = data.getData();\n"
        "        publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"copying\\\"}\");\n"
        "        new Thread(() -> {\n"
        "            try {\n"
        "                java.io.File temp = new java.io.File(getCacheDir(), \"import.mrpack\");\n"
        "                try (java.io.InputStream in = getContentResolver().openInputStream(uri);\n"
        "                     java.io.FileOutputStream out = new java.io.FileOutputStream(temp)) {\n"
        "                    if (in == null) throw new java.io.IOException(\"读不到文件\");\n"
        "                    byte[] buffer = new byte[64 * 1024];\n"
        "                    int read;\n"
        "                    while ((read = in.read(buffer)) != -1) out.write(buffer, 0, read);\n"
        "                }\n"
        "                publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"installing\\\"}\");\n"
        "                String summary = ModpackInstaller.install(temp, ModBrowser.target());\n"
        "                publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"done\\\",\\\"summary\\\":\" + org.json.JSONObject.quote(summary) + \"}\");\n"
        "            } catch (Throwable error) {\n"
        "                publish(\"{\\\"type\\\":\\\"modpack\\\",\\\"stage\\\":\\\"error\\\",\\\"message\\\":\" + org.json.JSONObject.quote(String.valueOf(error.getMessage())) + \"}\");\n"
        "            }\n"
        "        }).start();\n"
        "    }",
    )
    ACTIVITY.write_text(text, encoding="utf-8")
    print("AiChatActivity 已加文件选择 + 后台安装")


def patch_bridge():
    text = BRIDGE.read_text(encoding="utf-8")
    if "pickModpack" in text:
        print("AiBridge 已有 pickModpack")
        return
    anchor = "    /** 关闭当前页面（网页里的「返回」按钮用） */"
    assert anchor in text
    addition = ('    /** 打开文件选择器挑 .mrpack（网页里的「导入整合包」按钮用） */\n'
                '    @JavascriptInterface\n'
                '    public void pickModpack() {\n'
                '        try {\n'
                '            if (activity instanceof AiChatActivity) ((AiChatActivity) activity).pickModpackFile();\n'
                '        } catch (Throwable ignored) {\n'
                '        }\n'
                '    }\n\n'
                '    /** 给 Activity 用：把事件推回网页 */\n'
                '    public void publishEvent(String json) {\n'
                '        push(json);\n'
                '    }\n\n')
    text = text.replace(anchor, addition + anchor, 1)
    BRIDGE.write_text(text, encoding="utf-8")
    print("AiBridge 已加 pickModpack / publishEvent")


def patch_mods_html():
    text = MODS.read_text(encoding="utf-8")
    if "btnImport" in text:
        print("mods.html 已有导入按钮")
        return
    # 1) 在搜索栏下面加一个导入按钮行
    anchor = '<div id="status">先搜一个试试。</div>'
    assert anchor in text
    text = text.replace(
        anchor,
        '<div class="importbar"><button id="btnImport">导入 .mrpack 整合包</button>'
        '<span class="import-hint">从手机文件里选 Modrinth 整合包</span></div>\n' + anchor,
        1,
    )
    # 2) 样式
    style_anchor = "  #status {"
    text = text.replace(
        style_anchor,
        "  .importbar { display: flex; gap: 8px; align-items: center; padding: 8px 12px; border-bottom: 1px solid var(--line); }\n"
        "  .import-hint { font-size: 11.5px; color: var(--muted); }\n"
        "  #status {",
        1,
    )
    # 3) 事件处理
    event_anchor = "    if (e.type !== 'mod') return;"
    text = text.replace(
        event_anchor,
        "    if (e.type === 'modpack') {\n"
        "      if (e.stage === 'copying') setStatus('正在读取整合包文件…');\n"
        "      else if (e.stage === 'installing') setStatus('正在下载整合包里的文件（可能要一会儿）…');\n"
        "      else if (e.stage === 'done') setStatus('✓ ' + (e.summary || '整合包装好了'));\n"
        "      else if (e.stage === 'error') setStatus('✕ 整合包安装失败：' + (e.message || '未知错误'));\n"
        "      else if (e.stage === 'cancelled') setStatus('已取消导入。');\n"
        "      return;\n"
        "    }\n" + event_anchor,
        1,
    )
    click_anchor = "  document.getElementById('btnSearch').addEventListener('click', doSearch);"
    text = text.replace(
        click_anchor,
        "  document.getElementById('btnImport').addEventListener('click', function () {\n"
        "    try { CubeFish.pickModpack(); } catch (err) { setStatus('无法打开文件选择器：' + err); }\n"
        "  });\n" + click_anchor,
        1,
    )
    MODS.write_text(text, encoding="utf-8")
    print("mods.html 已加导入按钮 + 事件")


if __name__ == "__main__":
    patch_activity()
    patch_bridge()
    patch_mods_html()
