#!/usr/bin/env python3
"""方块鱼：局域网文件服务（给手机下载 APK / 游戏文件镜像用）。

比 python -m http.server 强的地方：
  * HTTP/1.1 长连接（几千个小文件不用反复握手，手机上快很多）
  * 并发连接队列放大到 128（16 个下载线程同时来也不会被拒）
  * 镜像目录里没有的文件，自动从 Mojang 官方服务器拉取并缓存到本地
    （手机永远只连电脑，任意版本/任意文件都能走这条路；第一次慢，之后都快）
  * 安静模式，只在出错时打日志

用法：
    python serve.py                       # 默认 8765 端口，服务 D:\\CubeFish-Mobile\\download
    python serve.py --port 8765 --root D:\\CubeFish-Mobile\\download
"""
import argparse
import http.client
import http.server
import mimetypes
import os
import shutil
import socket
import sys
import threading
import time
import urllib.error
import urllib.request

USER_AGENT = "CubeFishLAN/1.0"
MIRROR_PREFIX = "/mirror/"

UPSTREAM_ASSETS = "https://resources.download.minecraft.net/"
UPSTREAM_MAVEN = "https://libraries.minecraft.net/"
UPSTREAM_PISTON_META = "https://piston-meta.mojang.com/"
UPSTREAM_PISTON_DATA = "https://piston-data.mojang.com/"

_fetch_locks = {}
_fetch_locks_guard = threading.Lock()


def _lock_for(path):
    with _fetch_locks_guard:
        lock = _fetch_locks.get(path)
        if lock is None:
            lock = threading.Lock()
            _fetch_locks[path] = lock
        return lock


def upstream_urls(rest):
    """镜像里的相对路径 -> 上游官方 URL 列表（404 就试下一个）。"""
    if rest.startswith("assets/"):
        return [UPSTREAM_ASSETS + rest[len("assets/"):]]
    if rest.startswith("maven/"):
        return [UPSTREAM_MAVEN + rest[len("maven/"):]]
    path = rest[1:] if rest.startswith("/") else rest
    return [UPSTREAM_PISTON_META + path, UPSTREAM_PISTON_DATA + path]


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "CubeFishLAN/1.0"

    def log_message(self, fmt, *args):  # noqa: A003
        pass

    def log_error(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

    # ---------- 路由 ----------
    def do_GET(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if not path.startswith(MIRROR_PREFIX):
            return super().do_GET()
        local = self.translate_path(path)
        if os.path.isfile(local):
            return super().do_GET()
        return self.proxy_fetch(path, local)

    def do_HEAD(self):  # noqa: N802
        path = self.path.split("?", 1)[0]
        if not path.startswith(MIRROR_PREFIX):
            return super().do_HEAD()
        local = self.translate_path(path)
        if os.path.isfile(local):
            return super().do_HEAD()
        rest = path[len(MIRROR_PREFIX):]
        for url in upstream_urls(rest):
            try:
                request = urllib.request.Request(url, method="HEAD",
                                                 headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=30) as response:
                    length = response.headers.get("Content-Length")
                self.send_response(200)
                if length is not None:
                    self.send_header("Content-Length", length)
                self.send_header("Content-Type", self.guess_type(path))
                self.end_headers()
                return
            except urllib.error.HTTPError as error:
                if error.code == 404:
                    continue
                break
            except Exception:  # noqa: BLE001
                break
        self.send_error(404, "Not Found")

    # ---------- 按需拉取 + 缓存 ----------
    def proxy_fetch(self, path, local):
        rest = path[len(MIRROR_PREFIX):]
        urls = upstream_urls(rest)
        if not urls:
            return self.send_error(404, "Not Found")
        lock = _lock_for(local)
        with lock:
            if os.path.isfile(local):
                return super().do_GET()
            for url in urls:
                try:
                    self.stream_upstream(url, local, path)
                    return None
                except urllib.error.HTTPError as error:
                    if error.code == 404:
                        continue
                    self.log_error("上游返回 %s：%s", error.code, url)
                    break
                except Exception as error:  # noqa: BLE001
                    self.log_error("拉取失败 %s：%s", url, error)
                    break
        return self.send_error(404, "Not Found")

    def stream_upstream(self, url, local, path):
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        response = urllib.request.urlopen(request, timeout=60)
        try:
            length = response.headers.get("Content-Length")
            os.makedirs(os.path.dirname(local), exist_ok=True)
            tmp = local + ".part"
            if not length:
                # 上游没给长度：先完整读下来再回给手机
                data = response.read()
                self._send_ok(path, str(len(data)))
                self.wfile.write(data)
                with open(tmp, "wb") as out:
                    out.write(data)
                os.replace(tmp, local)
                return
            total = int(length)
            self._send_ok(path, length)
            written = 0
            with open(tmp, "wb") as out:
                while True:
                    chunk = response.read(1 << 16)
                    if not chunk:
                        break
                    out.write(chunk)
                    self.wfile.write(chunk)
                    written += len(chunk)
            if written != total:
                os.remove(tmp)
                raise IOError("上游数据不完整：%s" % url)
            os.replace(tmp, local)
        finally:
            response.close()

    def _send_ok(self, path, length):
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Length", length)
        self.end_headers()

    def guess_type(self, path):
        guessed = mimetypes.guess_type(path)[0]
        return guessed or "application/octet-stream"


class Server(http.server.ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 128
    allow_reuse_address = True


def lan_addresses():
    addresses = []
    try:
        hostname = socket.gethostname()
        for info in socket.getaddrinfo(hostname, None, socket.AF_INET):
            addr = info[4][0]
            if not addr.startswith("127.") and addr not in addresses:
                addresses.append(addr)
    except OSError:
        pass
    if not addresses:
        try:
            probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            probe.connect(("10.255.255.255", 1))
            addresses.append(probe.getsockname()[0])
            probe.close()
        except OSError:
            pass
    return addresses


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", default=r"D:\CubeFish-Mobile\download")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()

    os.chdir(args.root)
    server = Server(("0.0.0.0", args.port), Handler)
    print("方块鱼局域网服务已启动")
    print("  目录：%s" % args.root)
    for addr in lan_addresses():
        print("  手机访问：http://%s:%d/" % (addr, args.port))
        print("  游戏文件镜像：http://%s:%d/mirror" % (addr, args.port))
    print("  镜像里没有的文件会自动从 Mojang 拉取并缓存（第一次慢，之后快）")
    print("按 Ctrl+C 停止")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
