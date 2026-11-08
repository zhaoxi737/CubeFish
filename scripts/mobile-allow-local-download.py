"""方块鱼手机版 M2.7：让离线（本地）账号也能下载游戏版本。

上游 MinecraftDownloader 把「本地账号」和「没网」混在同一条判断里：
    if (isLocalProfile || !isOnline) { 只检查文件在不在，不下载 }
于是离线账号建了版本后点启动，只会去读 .json，直接 ENOENT（用户报的那个 FileNotFoundException）。
改成只有「真的没网」才走检查分支，有网就正常下载。
"""
from pathlib import Path

TARGET = Path(
    r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\tasks\MinecraftDownloader.java"
)

OLD_GATE = "                if(isLocalProfile || !isOnline) {"
NEW_GATE = ("                // 方块鱼：本地（离线）账号也允许下载游戏版本。\n"
            "                // 上游把本地账号当成「不能下载」，只做文件存在性检查，导致建好版本点启动直接报 ENOENT。\n"
            "                if(!isOnline) {")

OLD_MSG = '''                        String tryagain = !isOnline ? "Please ensure you have an internet connection" : "Please try again on your Microsoft Account";
                        Tools.showErrorRemote(versionMessage + " is not currently installed. "+ tryagain, e);'''
NEW_MSG = '''                        Tools.showErrorRemote("Minecraft " + versionMessage + " 还没下载完：请连好网络后再点一次启动，会自动下载。", e);'''

OLD_ELSE = """                }else {
                downloadGame(activity, version, realVersion);
                listener.onDownloadDone();
                }"""
NEW_ELSE = """                } else {
                    downloadGame(activity, version, realVersion);
                    listener.onDownloadDone();
                }"""


def main() -> None:
    text = TARGET.read_text(encoding="utf-8")
    changed = False
    for old, new, label in (
        (OLD_GATE, NEW_GATE, "放开本地账号下载"),
        (OLD_MSG, NEW_MSG, "错误提示改中文"),
        (OLD_ELSE, NEW_ELSE, "else 分支排版"),
    ):
        if old in text:
            text = text.replace(old, new, 1)
            print("已修改:", label)
            changed = True
        else:
            print("跳过（没找到）:", label)
    if changed:
        TARGET.write_text(text, encoding="utf-8")
    print("done")


if __name__ == "__main__":
    main()
