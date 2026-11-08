"""方块鱼手机版 M4：把内置控制布局（摇杆/游戏内按钮）的名字换成中文。

assets/default.json 里每个按钮的 name 就是游戏里显示的文字（Jump/Sprint/Chat…），
这些是数据不是资源，所以中文包里也还是英文。这里直接改 JSON 里的 name。
"""
import json
import xml.etree.ElementTree as ET
from pathlib import Path

DEFAULT_JSON = Path(
    r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\default.json"
)

NAMES = {
    "Jump": "跳跃",
    "Off\nHand": "换手",
    "Menu": "菜单",
    "Crouch": "潜行",
    "Right\nClick": "右键",
    "Left\nClick": "左键",
    "Middle\nClick": "中键",
    "Inv.": "背包",
    "Sprint": "疾跑",
    "Hide\nGUI": "隐藏界面",
    "Pause": "暂停",
    "Inventory": "物品栏",
    "Exit\nMenu": "退出菜单",
    "CTRL": "控制键",
    "Shift": "Shift",
    "Third\nPerson": "第三人称",
    "Debug\nMenu": "调试菜单",
    "Offhand": "副手",
    "Mouse\nToggle": "鼠标开关",
    "Chat": "聊天",
    "Keyboard": "键盘",
    "HUD\nToggle": "界面开关",
    "Drop\nItem": "丢弃物品",
    "Player\nList": "玩家列表",
    "More": "更多",
    "Hi There (this is a joystick why is this here, hello?)": "摇杆",
    "Welcome to the Editor.\nTap a button to see what you can do!\nTap the gear at the top to see more options.":
        "欢迎来到编辑器。\n点任意按钮看看能做什么！\n点顶部齿轮看更多选项。",
}


def translate(node, changed):
    if isinstance(node, dict):
        for key, value in list(node.items()):
            if key == "name" and isinstance(value, str) and value in NAMES:
                node[key] = NAMES[value]
                changed.append(value)
            else:
                translate(value, changed)
    elif isinstance(node, list):
        for item in node:
            translate(item, changed)


def main() -> None:
    data = json.loads(DEFAULT_JSON.read_text(encoding="utf-8"))
    changed = []
    translate(data, changed)
    DEFAULT_JSON.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"已翻译 {len(changed)} 个按钮名：")
    for name in sorted(set(changed)):
        print("  -", name.replace("\n", "\\n"), "→", NAMES[name].replace("\n", "\\n"))

    # 顺便看看还有哪些控制相关字符串没翻译
    res = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\res")

    def keys(path):
        if not path.exists():
            return {}
        root = ET.parse(path).getroot()
        return {e.get("name"): (e.get("translatable", "true") != "false") for e in root.findall("string")}

    base = keys(res / "values" / "strings.xml")
    zh = keys(res / "values-zh-rCN" / "strings.xml")
    missing = [k for k in base if k not in zh and base[k]]
    control = [k for k in missing if any(t in k for t in ("customctrl", "control", "menu", "editor", "cursor"))]
    print(f"\n仍缺中文的字符串 {len(missing)} 条，其中控制相关 {len(control)} 条：")
    for key in sorted(control):
        print("  ·", key)


if __name__ == "__main__":
    main()
