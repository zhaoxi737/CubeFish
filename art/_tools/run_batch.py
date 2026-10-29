import json
import sys
import os

TOOLS = r"D:\QDOQMC\art\_tools"
sys.path.insert(0, TOOLS)
import make_job
import comfy_gen

specs = json.load(open(os.path.join(TOOLS, "specs_batch.json"), encoding="utf-8"))
results = []
for spec in specs:
    job = make_job.build(spec)
    pid = comfy_gen.submit(job["workflow"])
    print("submitted", spec["out"], pid, flush=True)
    entry, elapsed = comfy_gen.wait(pid)
    if entry is None:
        print("FAILED", spec["out"], flush=True)
        results.append({"out": spec["out"], "ok": False})
        continue
    imgs = comfy_gen.find_images(entry)
    dest = spec["out"]
    size = comfy_gen.download(imgs[0], dest)
    meta = job["meta"]
    meta.update({"seconds": round(elapsed, 1), "prompt_id": pid, "bytes": size,
                 "output": dest, "comfy_filename": imgs[0]["filename"]})
    with open(dest + ".json", "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print("OK", dest, "%.1fs" % elapsed, size, "bytes", flush=True)
    results.append({"out": dest, "ok": True, "seconds": round(elapsed, 1)})
print(json.dumps(results, ensure_ascii=False))
