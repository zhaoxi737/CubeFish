"""方块鱼手机版 M10：精简游戏内控制布局。

问题：屏幕上按键太多遮画面，顶上一排「菜单/隐藏界面/暂停/物品栏/退出菜单」+ 中间那块
「欢迎来到编辑器」提示都在挡视线。

做法（改 assets/default.json）：
- 屏幕上只留：跳跃 / 潜行 / 疾跑 / 左键 / 右键 / 背包 + 摇杆 + 「更多」抽屉按钮
- 其余全部收进「更多」抽屉（点开才显示）：换手 / 中键 / 物品栏 / 界面开关 / 隐藏界面 /
  菜单 / 暂停 / 退出菜单 / 控制键 / Shift / 第三人称 / 调试菜单 / 副手 / 鼠标开关 /
  聊天 / 键盘 / 丢弃物品 / 玩家列表
- 删掉中间那块「欢迎来到编辑器」提示按钮
- 抽屉朝向改 LEFT（从按钮往左展开）
"""
import json
from pathlib import Path

DEFAULT_JSON = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\default.json")
ASSET_MANAGER = Path(
    r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\tasks\AsyncAssetManager.java"
)

KEEP_ON_SCREEN = {"跳跃", "潜行", "疾跑", "左键", "右键", "背包"}
DROP = {"欢迎来到编辑器。\n点任意按钮看看能做什么！\n点顶部齿轮看更多选项。"}


def main() -> None:
    data = json.loads(DEFAULT_JSON.read_text(encoding="utf-8"))
    controls = data["mControlDataList"]
    drawer = data["mDrawerDataList"][0]
    in_drawer = {button["name"] for button in drawer["buttonProperties"]}

    keep = []
    moved = []
    for control in controls:
        name = control.get("name", "")
        if name in DROP:
            print("删除提示按钮:", name.split("\n")[0])
            continue
        if name in KEEP_ON_SCREEN:
            keep.append(control)
        elif name in in_drawer:
            # 已经在抽屉里的，保持原来的抽屉顺序（后面统一重建）
            continue
        else:
            moved.append(control)
            print("收进抽屉:", name)
    keep_names = {c["name"] for c in keep}
    for control in keep:
        print("留在屏幕:", control["name"])

    # 抽屉内容 = 原有抽屉内容 + 新收进来的（保持原有顺序，新的排后面）
    existing = {b["name"]: b for b in drawer["buttonProperties"]}
    ordered = [b for b in drawer["buttonProperties"] if b["name"] not in keep_names]
    for control in moved:
        ordered.append(control)

    drawer["buttonProperties"] = ordered
    drawer["orientation"] = "LEFT"
    data["mControlDataList"] = keep

    DEFAULT_JSON.write_text(
        json.dumps(data, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\n屏幕按钮 {len(keep)} 个，抽屉按钮 {len(ordered)} 个")

    # 老用户一次性迁移：把新布局覆盖到 controlmap/default.json（旧文件备份成 default.prev.json）
    text = ASSET_MANAGER.read_text(encoding="utf-8")
    if "cubefish_controls_compact_v1" in text:
        print("迁移代码已存在")
        return
    anchor = '''                } catch (Throwable error) {
                    Log.e("CubeFish", "中文控制布局迁移失败", error);
                }'''
    addition = '''                } catch (Throwable error) {
                    Log.e("CubeFish", "中文控制布局迁移失败", error);
                }
                // 方块鱼：精简控制布局（按键太多遮画面）——一次性覆盖，旧布局备份成 default.prev.json
                try {
                    android.content.SharedPreferences prefs2 =
                            android.preference.PreferenceManager.getDefaultSharedPreferences(ctx);
                    if (!prefs2.getBoolean("cubefish_controls_compact_v1", false)) {
                        File currentDefault = new File(Tools.CTRLDEF_FILE);
                        if (currentDefault.exists()) {
                            try {
                                org.apache.commons.io.FileUtils.copyFile(
                                        currentDefault, new File(Tools.CTRLMAP_PATH, "default.prev.json"));
                            } catch (IOException ignored) {
                            }
                        }
                        Tools.copyAssetFile(ctx, "default.json", Tools.CTRLMAP_PATH, true);
                        prefs2.edit().putBoolean("cubefish_controls_compact_v1", true).apply();
                        Log.i("CubeFish", "控制布局已精简（按键收进「更多」抽屉）");
                    }
                } catch (Throwable error) {
                    Log.e("CubeFish", "精简控制布局迁移失败", error);
                }'''
    assert anchor in text
    ASSET_MANAGER.write_text(text.replace(anchor, addition, 1), encoding="utf-8")
    print("AsyncAssetManager 已加一次性迁移")


if __name__ == "__main__":
    main()
