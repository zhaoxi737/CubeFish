"""方块鱼手机版 M9：
1. 首次启动自动测速：官方源 vs BMCLAPI 镜像，谁快用谁（用户自己选过就不动）
2. 元数据/库/资源下载线程 6 → 8
3. 下载源生效后弹提示（含速度数字）
"""
from pathlib import Path

PROBE = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\utils\SourceSpeedProbe.java")
LAUNCHER = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\LauncherActivity.java")
DOWNLOADER = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\tasks\MinecraftDownloader.java")

PROBE_CODE = '''package net.kdt.pojavlaunch.utils;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.preference.PreferenceManager;
import android.widget.Toast;

import net.kdt.pojavlaunch.prefs.LauncherPreferences;

/** 方块鱼：首次启动自动测「官方源 / BMCLAPI 镜像」速度，自动选快的那个。 */
public final class SourceSpeedProbe {
    private static final String OFFICIAL = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
    private static final String BMCLAPI = "https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json";
    private static final long PROBE_BYTES = 512 * 1024L;

    private SourceSpeedProbe() {
    }

    public static void autoSelectIfNeeded(Context context) {
        final Context appContext = context.getApplicationContext();
        SharedPreferences prefs = PreferenceManager.getDefaultSharedPreferences(appContext);
        if (prefs.getBoolean("cube_source_probed_v1", false)) return;
        if (prefs.contains("downloadSource")) return; // 用户自己选过，尊重
        new Thread(() -> {
            long official = probe(OFFICIAL);
            long bmclapi = probe(BMCLAPI);
            String choice;
            if (bmclapi <= 0 && official <= 0) return;
            choice = bmclapi >= official ? "bmclapi" : "default";
            prefs.edit().putString("downloadSource", choice).putBoolean("cube_source_probed_v1", true).apply();
            LauncherPreferences.PREF_DOWNLOAD_SOURCE = choice;
            final String text = "下载源自动选择：" + (choice.equals("bmclapi") ? "BMCLAPI 镜像" : "官方源")
                    + "（镜像 " + kb(bmclapi) + " / 官方 " + kb(official) + " KB/s）";
            new Handler(Looper.getMainLooper()).post(() -> {
                try {
                    Toast.makeText(appContext, text, Toast.LENGTH_LONG).show();
                } catch (Throwable ignored) {
                }
            });
        }, "cube-source-probe").start();
    }

    /** 下 512KB 测每秒多少 KB；失败返回 0 */
    private static long probe(String url) {
        java.net.HttpURLConnection conn = null;
        try {
            conn = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("User-Agent", "CubeFish-Mobile");
            conn.setRequestProperty("Range", "bytes=0-" + (PROBE_BYTES - 1));
            int code = conn.getResponseCode();
            if (code >= 400) return 0;
            long started = System.currentTimeMillis();
            java.io.InputStream in = conn.getInputStream();
            byte[] buffer = new byte[32 * 1024];
            long total = 0;
            int read;
            while ((read = in.read(buffer)) != -1) {
                total += read;
                if (total >= PROBE_BYTES) break;
            }
            in.close();
            long ms = Math.max(1, System.currentTimeMillis() - started);
            return (total * 1000L) / ms / 1024L;
        } catch (Throwable error) {
            return 0;
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private static long kb(long value) {
        return Math.max(0, value);
    }
}
'''


def write_probe() -> None:
    PROBE.write_text(PROBE_CODE, encoding="utf-8")
    print("SourceSpeedProbe 已写入")


def patch_launcher() -> None:
    text = LAUNCHER.read_text(encoding="utf-8")
    if "SourceSpeedProbe" in text:
        print("LauncherActivity 已接入测速")
        return
    anchor = "        ProgressKeeper.addTaskCountListener((mProgressServiceKeeper = new ProgressServiceKeeper(this)));"
    addition = anchor + "\n        // 方块鱼：首次启动测一次下载源速度（官方 vs BMCLAPI），自动选快的\n        net.kdt.pojavlaunch.utils.SourceSpeedProbe.autoSelectIfNeeded(this);"
    assert anchor in text
    LAUNCHER.write_text(text.replace(anchor, addition, 1), encoding="utf-8")
    print("LauncherActivity 已接入测速")


def patch_threads() -> None:
    text = DOWNLOADER.read_text(encoding="utf-8")
    old = "new ThreadPoolExecutor(6, 6, 500, TimeUnit.MILLISECONDS, taskQueue)"
    new = "new ThreadPoolExecutor(8, 8, 500, TimeUnit.MILLISECONDS, taskQueue)"
    if old in text:
        DOWNLOADER.write_text(text.replace(old, new, 1), encoding="utf-8")
        print("下载线程 6 → 8")
    else:
        print("线程参数没找到，跳过")


if __name__ == "__main__":
    write_probe()
    patch_launcher()
    patch_threads()
