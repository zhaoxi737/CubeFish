import io
p = r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\prefs\LauncherPreferences.java"
data = open(p, "rb").read()
lines = data.split(b"\n")
for i, ln in enumerate(lines):
    if b"BMCLAPI" in ln and b"//" in ln and b"\xe9\xbb\x98" not in ln and b"\xe4\xb8\x8b\xe8\xbd\xbd" not in ln:
        # 旧注释被 GBK/UTF-8 互转弄坏了，整行替换
        lines[i] = "        // 方块鱼：下载源默认官方源（bmclapi / custom 由用户在设置里选择）".encode("utf-8")
        print("fixed line", i + 1)
open(p, "wb").write(b"\n".join(lines))
print("ok")
