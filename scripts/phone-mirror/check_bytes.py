p = r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\java\net\kdt\pojavlaunch\prefs\LauncherPreferences.java"
data = open(p, "rb").read()
print("has BOM:", data[:3] == b"\xef\xbb\xbf")
lines = data.split(b"\n")
for i, ln in enumerate(lines):
    if b"BMCLAPI" in ln:
        print(i + 1, repr(ln))
        try:
            print("   decoded:", ln.decode("utf-8"))
        except UnicodeDecodeError as e:
            print("   NOT valid utf-8:", e)
