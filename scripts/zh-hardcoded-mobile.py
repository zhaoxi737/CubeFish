"""把手机版界面里硬编码的英文文案换成中文（方块鱼 M2.5）。

只改布局 XML 里的 android:text / android:hint 字面量，改的是上游硬编码英文
（这些本来就没进 strings.xml，所以在中文系统下也显示英文）。
"""
from pathlib import Path

RES = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\res\layout")

REPLACEMENTS = {
    "fragment_select_auth_method.xml": [
        ('android:text="Microsoft Account"', 'android:text="微软账号登录（正版）"'),
        ('android:text="Local account"', 'android:text="本地登录（离线 / 免正版）"'),
    ],
    "fragment_create_modpack_profile.xml": [
        ('android:text="Browse Modpacks"', 'android:text="浏览整合包"'),
        ('android:text="Import Zip or mrpack"', 'android:text="导入 .zip / .mrpack"'),
    ],
    "fragment_profile_editor.xml": [
        ('android:text="Custom path"', 'android:text="自定义路径"'),
    ],
    "activity_import_control.xml": [
        ('android:text="File name:"', 'android:text="文件名称："'),
        ('android:hint="File name"', 'android:hint="文件名称"'),
    ],
    "activity_java_gui_launcher.xml": [
        ('android:text="Keyboard"', 'android:text="键盘"'),
        ('android:text="Copy"', 'android:text="复制"'),
        ('android:text="Paste"', 'android:text="粘贴"'),
    ],
    "dialog_control_button_setting.xml": [
        ('android:hint="Button Name"', 'android:hint="按钮名称"'),
    ],
}


def main() -> None:
    for file_name, pairs in REPLACEMENTS.items():
        path = RES / file_name
        if not path.exists():
            print("跳过（不存在）:", file_name)
            continue
        text = path.read_text(encoding="utf-8")
        changed = 0
        for old, new in pairs:
            if old in text:
                text = text.replace(old, new)
                changed += 1
        if changed:
            path.write_text(text, encoding="utf-8")
        print(f"{file_name}: 替换 {changed} 处")


if __name__ == "__main__":
    main()
