#!/usr/bin/env python3
"""方块鱼：在电脑上预下载 Minecraft 官方文件，做成 BMCLAPI 兼容的局域网镜像目录。

用法：
    python mirror.py 1.20.1
    python mirror.py 1.20.1 --root D:\\CubeFish-Mobile\\download\\mirror

生成的目录结构（方块鱼 App 里填 http://<电脑IP>:<端口>/mirror 即可）：
    <root>/mc/game/version_manifest_v2.json
    <root>/v1/packages/<sha1>/1.20.1.json      (版本 JSON / 资源索引)
    <root>/v1/objects/<sha1>/client.jar
    <root>/maven/<组/织/路径>.jar              (libraries)
    <root>/assets/<hh>/<sha1>                  (assets objects)

已下载且 sha1 匹配的文件会跳过，中断后重跑可以续传。
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import sys
import threading
import time
import urllib.request

UA = "CubeFish-Mirror/1.0"
MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"

HOST_MAP = {
    "piston-meta.mojang.com": "",
    "launchermeta.mojang.com": "",
    "launcher.mojang.com": "",
    "piston-data.mojang.com": "",
    "libraries.minecraft.net": "/maven",
    "resources.download.minecraft.net": "/assets",
}

_lock = threading.Lock()
_stats = {"files": 0, "bytes": 0, "skipped": 0, "total_files": 0, "total_bytes": 0}


def log(msg):
    with _lock:
        print(msg, flush=True)


def http_get(url, retries=5, timeout=90):
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return resp.read()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(1.0 + attempt * 2.0)
    raise RuntimeError("下载失败 %s: %s" % (url, last))


def sha1_of(path):
    h = hashlib.sha1()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def mirror_rel(url):
    """把官方 URL 映射到镜像目录里的相对路径。"""
    proto_end = url.find("://")
    if proto_end < 0:
        return None
    host_start = proto_end + 3
    path_start = url.find("/", host_start)
    if path_start < 0:
        return None
    host = url[host_start:path_start]
    path = url[path_start:]
    prefix = HOST_MAP.get(host)
    if prefix is None:
        return None
    return (prefix + path).lstrip("/").replace("/", os.sep)


def fetch_into(root, url, sha1=None, size=None, label=""):
    rel = mirror_rel(url)
    if rel is None:
        return "skip-host"
    target = os.path.join(root, rel)
    if os.path.isfile(target):
        try:
            is_ok = (sha1_of(target) == sha1) if sha1 else (size is None or os.path.getsize(target) == size)
            if is_ok:
                with _lock:
                    _stats["skipped"] += 1
                    _stats["files"] += 1
                    if size:
                        _stats["bytes"] += size
                return "skip"
        except OSError:
            pass
    data = http_get(url)
    if sha1 and hashlib.sha1(data).hexdigest() != sha1:
        raise RuntimeError("sha1 校验失败: " + url)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    tmp = target + ".part"
    with open(tmp, "wb") as handle:
        handle.write(data)
    os.replace(tmp, target)
    with _lock:
        _stats["files"] += 1
        _stats["bytes"] += len(data)
    return "download"


def reporter(stop_event):
    start = time.time()
    while not stop_event.wait(3.0):
        with _lock:
            files, nbytes = _stats["files"], _stats["bytes"]
            total, ntotal = _stats["total_files"], _stats["total_bytes"]
        secs = max(0.001, time.time() - start)
        log("  进度 %d/%d 文件  %.1f/%.1f MB  %.2f MB/s"
            % (files, total, nbytes / 1048576.0, ntotal / 1048576.0, nbytes / 1048576.0 / secs))


def collect_version(url):
    """读取版本 JSON（含 inheritsFrom 父版本），返回 (版本们, 顺序)。"""
    chain = []
    while url:
        data = http_get(url)
        parsed = json.loads(data.decode("utf-8"))
        chain.append((url, mirror_rel(url), data, parsed))
        parent = parsed.get("inheritsFrom")
        if not parent:
            break
        # 父版本 ID 需要通过版本列表找 url
        url = version_urls.get(parent)
        if not url:
            raise RuntimeError("找不到父版本 %s 的 URL" % parent)
    return chain


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("version", help="Minecraft 版本号，例如 1.20.1")
    parser.add_argument("--root", default=r"D:\CubeFish-Mobile\download\mirror")
    parser.add_argument("--workers", type=int, default=16)
    args = parser.parse_args()

    global version_urls
    os.makedirs(args.root, exist_ok=True)
    log("== 方块鱼局域网镜像 ==")
    log("版本：%s" % args.version)
    log("目录：%s" % args.root)

    log("[1/5] 版本列表…")
    manifest_url = MANIFEST
    manifest_data = http_get(manifest_url)
    fetch_into(args.root, manifest_url, size=len(manifest_data))
    manifest = json.loads(manifest_data.decode("utf-8"))
    version_urls = {v["id"]: v["url"] for v in manifest["versions"]}
    log("      共 %d 个版本" % len(version_urls))
    target_url = version_urls.get(args.version)
    if not target_url:
        sys.exit("版本不存在: " + args.version)

    log("[2/5] 版本 JSON / 资源索引…")
    chain = collect_version(target_url)
    merged = {"libraries": [], "assetIndex": None, "downloads": {}, "logging": None}
    for _url, _rel, data, parsed in reversed(chain):
        fetch_into(args.root, _url, size=len(data))
        if parsed.get("libraries"):
            merged["libraries"].extend(parsed["libraries"])
        if parsed.get("assetIndex"):
            merged["assetIndex"] = parsed["assetIndex"]
        if parsed.get("downloads"):
            merged["downloads"].update(parsed["downloads"])
        if parsed.get("logging"):
            merged["logging"] = parsed["logging"]

    tasks = []  # (url, sha1, size)

    if merged["assetIndex"]:
        idx = merged["assetIndex"]
        log("[3/5] 资源索引 %s…" % idx["id"])
        idx_data = http_get(idx["url"])
        fetch_into(args.root, idx["url"], sha1=idx.get("sha1"), size=len(idx_data))
        index = json.loads(idx_data.decode("utf-8"))
        objects = index.get("objects") or {}
        log("      %d 个资源对象" % len(objects))
        for _name, info in objects.items():
            h = info["hash"]
            tasks.append(("https://resources.download.minecraft.net/%s/%s" % (h[:2], h), h, info.get("size")))

    for key, info in (merged["downloads"] or {}).items():
        if info and info.get("url"):
            tasks.append((info["url"], info.get("sha1"), info.get("size")))

    for lib in merged["libraries"]:
        downloads = lib.get("downloads") or {}
        artifact = downloads.get("artifact")
        if artifact and artifact.get("url"):
            tasks.append((artifact["url"], artifact.get("sha1"), artifact.get("size")))
            continue
        if downloads.get("classifiers"):
            continue
        name = lib.get("name") or ""
        parts = name.split(":")
        if len(parts) != 3:
            continue
        group, artifact_id, ver = parts
        base = (lib.get("url") or "https://libraries.minecraft.net/").rstrip("/")
        path = "%s/%s/%s/%s-%s.jar" % (group.replace(".", "/"), artifact_id, ver, artifact_id, ver)
        tasks.append((base + "/" + path, None, None))

    tasks = [t for t in tasks if mirror_rel(t[0])]
    with _lock:
        _stats["total_files"] = len(tasks)
        _stats["total_bytes"] = sum(t[2] or 0 for t in tasks)
    log("[4/5] 开始下载 %d 个文件，约 %.0f MB（已存在的会跳过）…"
        % (len(tasks), _stats["total_bytes"] / 1048576.0))

    stop = threading.Event()
    thread = threading.Thread(target=reporter, args=(stop,), daemon=True)
    thread.start()

    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {pool.submit(fetch_into, args.root, url, sha1, size): url for url, sha1, size in tasks}
        for future in concurrent.futures.as_completed(futures):
            try:
                future.result()
            except Exception as exc:  # noqa: BLE001
                errors.append((futures[future], str(exc)))
                log("  !! 失败 %s" % exc)

    stop.set()
    log("[5/5] 完成：%d 个文件，%.0f MB，失败 %d 个"
        % (_stats["files"], _stats["bytes"] / 1048576.0, len(errors)))
    if errors:
        for url, err in errors[:20]:
            log("   失败 %s -> %s" % (url, err))
        sys.exit(1)


if __name__ == "__main__":
    version_urls = {}
    main()
