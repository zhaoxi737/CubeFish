"""方块鱼手机版 M8 代码改动：
1. 默认下载源改成 BMCLAPI 镜像（国内更快，镜像没有的文件自动回退官方）
2. 元数据/库/资源下载线程 4 → 6（游戏文件多，并发高一点更快）
3. 开始下载游戏时弹一条提示，说明进度在底部/通知栏
"""
from pathlib import Path

PREFS = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\prefs\LauncherPreferences.java")
DOWNLOADER = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\tasks\MinecraftDownloader.java")


def patch_prefs():
    text = PREFS.read_text(encoding="utf-8")
    old = 'PREF_DOWNLOAD_SOURCE = DEFAULT_PREF.getString("downloadSource", "default");'
    new = '// 方块鱼：默认走 BMCLAPI 镜像（镜像缺文件会自动回退官方），国内下载快很多\n        PREF_DOWNLOAD_SOURCE = DEFAULT_PREF.getString("downloadSource", "bmclapi");'
    if old not in text:
        print("LauncherPreferences: 没找到 downloadSource 行，跳过")
        return
    PREFS.write_text(text.replace(old, new, 1), encoding="utf-8")
    print("LauncherPreferences: 默认下载源 → bmclapi")


def patch_downloader():
    text = DOWNLOADER.read_text(encoding="utf-8")

    # 1) 线程数 4 → 6
    old_pool = "new ThreadPoolExecutor(4, 4, 500, TimeUnit.MILLISECONDS, taskQueue)"
    new_pool = "new ThreadPoolExecutor(6, 6, 500, TimeUnit.MILLISECONDS, taskQueue)"
    if old_pool in text:
        text = text.replace(old_pool, new_pool, 1)
        print("MinecraftDownloader: 下载线程 4 → 6")
    else:
        print("MinecraftDownloader: 没找到线程池，跳过")

    # 2) 下载开始时提示进度位置
    old_start = 'ProgressLayout.setProgress(ProgressLayout.DOWNLOAD_MINECRAFT, 0, R.string.newdl_starting);'
    new_start = ('ProgressLayout.setProgress(ProgressLayout.DOWNLOAD_MINECRAFT, 0, R.string.newdl_starting);\n'
                 '        // 方块鱼：告诉用户进度在哪看（底部进度条 + 通知栏）\n'
                 '        Tools.runOnUiThread(() -> {\n'
                 '            try {\n'
                 '                android.widget.Toast.makeText(activity, "开始下载游戏文件，进度见底部进度条和通知栏", android.widget.Toast.LENGTH_LONG).show();\n'
                 '            } catch (Throwable ignored) {\n'
                 '            }\n'
                 '        });')
    if old_start in text and "开始下载游戏文件" not in text:
        text = text.replace(old_start, new_start, 1)
        print("MinecraftDownloader: 下载开始提示已加")
    else:
        print("MinecraftDownloader: 提示已存在或没找到位置")

    DOWNLOADER.write_text(text, encoding="utf-8")


if __name__ == "__main__":
    patch_prefs()
    patch_downloader()
