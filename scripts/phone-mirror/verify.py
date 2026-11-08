#!/usr/bin/env python3
"""校验局域网镜像是否覆盖某个版本 App 会请求的全部文件（按方块鱼的 URL 映射规则）。"""
import hashlib
import json
import os
import random
import sys
import urllib.request

ROOT = r"D:\CubeFish-Mobile\download\mirror"
BASE = "http://127.0.0.1:8765/mirror"
UA = "CubeFish-Verify/1.0"
HOST_MAP = {
    "piston-meta.mojang.com": "",
    "launchermeta.mojang.com": "",
    "launcher.mojang.com": "",
    "piston-data.mojang.com": "",
    "libraries.minecraft.net": "/maven",
    "resources.download.minecraft.net": "/assets",
}


def rel_for(url):
    proto = url.find("://")
    start = proto + 3
    slash = url.find("/", start)
    host = url[start:slash]
    path = url[slash:]
    prefix = HOST_MAP.get(host)
    if prefix is None:
        return None
    return (prefix + path).lstrip("/")


def main():
    version = sys.argv[1] if len(sys.argv) > 1 else "1.20.1"
    manifest = json.load(open(os.path.join(ROOT, "mc", "game", "version_manifest_v2.json"), encoding="utf-8"))
    entry = next((v for v in manifest["versions"] if v["id"] == version), None)
    if entry is None:
        sys.exit("版本不在 list 里")
    checks = []  # (label, url)

    checks.append(("版本 JSON", entry["url"]))
    vpath = os.path.join(ROOT, rel_for(entry["url"]).replace("/", os.sep))
    vjson = json.load(open(vpath, encoding="utf-8"))
    if vjson.get("assetIndex"):
        checks.append(("资源索引", vjson["assetIndex"]["url"]))
        idx = json.load(open(os.path.join(ROOT, rel_for(vjson["assetIndex"]["url"]).replace("/", os.sep)),
                             encoding="utf-8"))
    else:
        idx = {"objects": {}}
    for key, info in (vjson.get("downloads") or {}).items():
        if info.get("url"):
            checks.append(("downloads/%s" % key, info["url"]))
    libs = 0
    for lib in vjson.get("libraries") or []:
        art = (lib.get("downloads") or {}).get("artifact")
        if art and art.get("url"):
            checks.append(("库 " + lib.get("name", "?"), art["url"]))
            libs += 1
    for _name, info in (idx.get("objects") or {}).items():
        h = info["hash"]
        checks.append(("资源", "https://resources.download.minecraft.net/%s/%s" % (h[:2], h)))

    missing = 0
    for label, url in checks:
        rel = rel_for(url)
        if rel is None:
            print("  [跳过-非镜像 URL] %s -> %s" % (label, url))
            continue
        full = os.path.join(ROOT, rel.replace("/", os.sep))
        if not os.path.isfile(full) or os.path.getsize(full) == 0:
            missing += 1
            if missing <= 10:
                print("  [缺失] %s -> %s" % (label, rel))
    print("检查项：%d（库 %d，资源 %d），缺失 %d" % (len(checks), libs, len(idx.get("objects") or {}), missing))

    # HTTP 抽样，确认服务端真能给出这些文件
    sample = random.sample(checks, min(8, len(checks)))
    sample.append(("版本列表", "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
    bad = 0
    for label, url in sample:
        rel = rel_for(url)
        if rel is None:
            continue
        try:
            request = urllib.request.Request(BASE + "/" + rel, headers={"User-Agent": UA})
            with urllib.request.urlopen(request, timeout=30) as response:
                data = response.read()
            size = len(data)
            if size == 0:
                bad += 1
                print("  [HTTP 空] %s" % label)
        except Exception as error:  # noqa: BLE001
            bad += 1
            print("  [HTTP 失败] %s -> %s" % (label, error))
    print("HTTP 抽样 %d 个，失败 %d" % (len(sample), bad))
    return 1 if (missing or bad) else 0


if __name__ == "__main__":
    sys.exit(main())
