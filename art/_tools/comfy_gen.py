"""Minimal ComfyUI HTTP client for the QDOQMC art task.

Usage: python comfy_gen.py job.json
job.json: {"out": "...", "workflow": {...}, "meta": {...}}
"""
import json
import sys
import os
import time
import uuid

import requests

SERVER = "http://127.0.0.1:8188"


def submit(wf):
    payload = {"prompt": wf, "client_id": str(uuid.uuid4())}
    r = requests.post(f"{SERVER}/prompt", json=payload, timeout=30)
    r.raise_for_status()
    body = r.json()
    if body.get("node_errors"):
        print("NODE_ERRORS:", json.dumps(body["node_errors"], ensure_ascii=False)[:2000])
    return body["prompt_id"]


def wait(prompt_id, timeout=900):
    t0 = time.time()
    while time.time() - t0 < timeout:
        r = requests.get(f"{SERVER}/history/{prompt_id}", timeout=30)
        r.raise_for_status()
        hist = r.json()
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                print("EXEC_ERROR:", json.dumps(status, ensure_ascii=False)[:3000])
                return None, time.time() - t0
            if status.get("completed") or entry.get("outputs"):
                return entry, time.time() - t0
        time.sleep(1.5)
    return None, time.time() - t0


def find_images(entry):
    out = []
    for node_id, node in entry.get("outputs", {}).items():
        for img in node.get("images", []):
            if img.get("type") == "temp":
                continue
            out.append(img)
    return out


def download(img, dest):
    params = {
        "filename": img["filename"],
        "subfolder": img.get("subfolder", ""),
        "type": img.get("type", "output"),
    }
    r = requests.get(f"{SERVER}/view", params=params, timeout=120)
    r.raise_for_status()
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(dest, "wb") as f:
        f.write(r.content)
    return len(r.content)


def main():
    spec_path = sys.argv[1]
    with open(spec_path, "r", encoding="utf-8") as f:
        spec = json.load(f)
    wf = spec["workflow"]
    t0 = time.time()
    pid = submit(wf)
    print("prompt_id:", pid, flush=True)
    entry, elapsed = wait(pid)
    if entry is None:
        print("FAILED after %.1fs" % elapsed)
        sys.exit(2)
    imgs = find_images(entry)
    if not imgs:
        print("NO_IMAGES")
        sys.exit(3)
    dest = spec["out"]
    size = download(imgs[0], dest)
    total = time.time() - t0
    meta = dict(spec.get("meta", {}))
    meta.update({"seconds": round(total, 1), "prompt_id": pid, "bytes": size,
                 "output": dest, "comfy_filename": imgs[0]["filename"]})
    with open(dest + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False))
    print("OK %s %.1fs %d bytes" % (dest, total, size))


if __name__ == "__main__":
    main()
