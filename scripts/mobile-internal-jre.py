"""方块鱼手机版 M8：把内置 Java 换成「上游 CI 同款内部布局」，修掉 JRE 17 安装失败。

问题：我们之前把 JRE17/21 的 tarball 放在 components/jre-external，再在 tryDownloadRuntime 里解压；
      但 amethyst 的安装流程会先尝试 InternalRuntime（components/jre-new / jre-21），
      缺失时走 tryDownloadRuntime 失败后直接 return false → 报「JRE 17 安装失败」。

现在按 CI 的方式准备内部布局：
  components/jre-new/{universal.tar.xz, bin-arm64.tar.xz, version}
  components/jre-21/{universal.tar.xz, bin-arm64.tar.xz, version}
其中 universal 是空的 tar.xz，bin-arm64 直接放上游的整包 tarball ——
installRuntimeNamedBinpack 先解 universal 再解 bin，结果就是完整 JRE。
"""
import io
import shutil
import tarfile
from pathlib import Path

ASSETS = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\assets\components")
SRC = Path(r"D:\CubeFish-Mobile\jre-external")

TARGETS = [
    ("jre-new", "jre17-android-arm64.tar.xz", "cubefish-jre17-arm64-1"),
    ("jre-21", "jre21-android-arm64.tar.xz", "cubefish-jre21-arm64-1"),
]


def empty_tar_xz() -> bytes:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:xz") as tar:
        pass
    return buffer.getvalue()


def main() -> None:
    universal = empty_tar_xz()
    print(f"empty universal.tar.xz = {len(universal)} bytes")

    for folder, tarball, version in TARGETS:
        src = SRC / tarball
        if not src.exists():
            print(f"跳过 {folder}：缺少 {src}")
            continue
        dest = ASSETS / folder
        dest.mkdir(parents=True, exist_ok=True)
        (dest / "universal.tar.xz").write_bytes(universal)
        shutil.copyfile(src, dest / tarball.replace("jre17-android-arm64", "bin-arm64").replace("jre21-android-arm64", "bin-arm64"))
        (dest / "version").write_text(version, encoding="utf-8")
        print(f"{folder}: bin-arm64.tar.xz = {round((dest / 'bin-arm64.tar.xz').stat().st_size / 1024 / 1024, 1)}MB, version={version}")

    external = ASSETS / "jre-external"
    if external.exists():
        shutil.rmtree(external)
        print("已删除 components/jre-external（避免 APK 里重复 53MB）")


if __name__ == "__main__":
    main()
