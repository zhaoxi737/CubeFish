"""补齐 values-zh-rCN 缺失的中文翻译（方块鱼手机版 M2.5）。

只补「上游没翻译、界面上会出现」的键；translatable="false" 的跳过。
幂等：已经存在的键不会重复写入。
"""
import re
import xml.etree.ElementTree as ET
from pathlib import Path

RES = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\res")
BASE = RES / "values" / "strings.xml"
ZH = RES / "values-zh-rCN" / "strings.xml"

# 手工翻译（键 → 中文）
TRANS = {
    "angelica_found_sfpew_notice": "检测到 Angelica 模组，不再需要 Simple FPE Wrapper",
    "autorendererselectfailed": "自动选择渲染器失败，已回退到 HolyGL4ES",
    "create_lwjgl3ify_profile": "创建 LWJGL3ify 配置",
    "delete_sodium": "删除 Sodium 并启动",
    "error_invalid_value": "错误！数值无效！",
    "error_key_unsupported": "错误！这个按钮绑定的按键无效，试试更新？",
    "global_download": "下载",
    "global_installing": "正在安装…",
    "global_not_installed": "未安装",
    "import_modpack_start": "正在导入整合包…",
    "import_modpack_hash": "正在计算整合包哈希…（%s MB / %s MB）",
    "import_modpack_json": "正在读取整合包信息…",
    "import_modpack_copy": "正在把整合包复制到缓存…（%s MB / %s MB）",
    "lwjgl3ify_installer_available_versions": "支持的 LWJGL3ify 版本",
    "lwjgl3ify_installer_broken_versions": "有问题的 LWJGL3ify 版本（SDL）",
    "mcl_setting_renderer_ng_gl4es": "使用 NG-GL4ES 渲染器",
    "mcl_setting_renderer_vulkan_kopper_zink": "使用 Vulkan（Kopper/Zink）渲染器",
    "mcl_setting_subtitle_keyboard_panning": "允许用键盘拖动界面",
    "mcl_setting_title_keyboard_panning": "键盘拖动界面",
    "mg_renderer_summary_dsaExt": "可能对 Iris 光影有帮助，AcceleratedRendering 模组需要它",
    "mg_renderer_title_dsaExt": "启用实验性 Direct State Access 扩展",
    "mg_renderer_title_fsr": "AMD FSR 1 超分辨率",
    "minecraft_no_username_set": "你的 Minecraft 用户名还没设置！请先在 Minecraft 官网设置用户名再登录。",
    "multirt_no_internet": "下载失败，请检查网络连接。",
    "neoforge_dl_searching": "正在查找 NeoForge 版本号",
    "new_default_controls": "已把新的默认控制布局导出到 new_default.json，可以试试",
    "newdl_downloading_jre_runtime": "正在下载 Java %s 运行时（%.2f/%.2f MB）",
    "not_modpack_file": "这不是整合包文件！",
    "sodium_override_summaryOff": "用 Sodium 可能出现画面错误和崩溃，风险自负。",
    "sodium_override_summaryOn": "官方不支持 Sodium，出问题不提供帮助。",
    "sodium_override_title": "强制运行 Sodium",
    "sodium_warning_message": "检测到 Sodium：官方不支持它，可能出现画面错误或崩溃，建议删掉它和依赖它的模组。",
    "sodium_warning_title": "检测到 Sodium！",
    "use_angle_checkbox": "使用 ANGLE（可能提高帧数）",
    "create_profile": "创建新配置",
    "generic_install": "安装",
    "version_select_hint": "选择版本",
}


def parse(path: Path):
    tree = ET.parse(path)
    root = tree.getroot()
    out = {}
    for node in root.findall("string"):
        name = node.get("name")
        translatable = node.get("translatable", "true")
        out[name] = (translatable != "false", (node.text or ""))
    return out


def main() -> None:
    base = parse(BASE)
    zh = parse(ZH)
    missing = [k for k in base if k not in zh]
    todo = [k for k in missing if base[k][0] and k in TRANS]
    untouched = [k for k in missing if k not in todo]
    print(f"missing={len(missing)} 可补={len(todo)} 跳过={len(untouched)}")
    if not todo:
        print("无需补")
        return

    text = ZH.read_text(encoding="utf-8")
    lines = []
    for key in todo:
        value = TRANS[key].replace("&", "&amp;")
        lines.append(f'    <string name="{key}">{value}</string>')
    block = "\n" + "\n".join(lines) + "\n"
    text = text.replace("</resources>", block + "</resources>") if "</resources>" in text else text + block
    ZH.write_text(text, encoding="utf-8")
    print("已写入：")
    for key in todo:
        print("  +", key)


if __name__ == "__main__":
    main()
