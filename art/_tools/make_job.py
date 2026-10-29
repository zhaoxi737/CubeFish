"""Build a ComfyUI API workflow JSON for SD1.5 txt2img.

Usage: python make_job.py spec.json out_job.json
spec: ckpt, pos, neg, width, height, seed, steps, cfg, sampler, scheduler, out, meta(optional)
"""
import json
import sys


def build(spec):
    ckpt = spec["ckpt"]
    wf = {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "2": {"class_type": "CLIPTextEncode",
              "inputs": {"text": spec["pos"], "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode",
              "inputs": {"text": spec["neg"], "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage",
              "inputs": {"width": spec["width"], "height": spec["height"], "batch_size": 1}},
        "5": {"class_type": "KSampler",
              "inputs": {
                  "seed": spec["seed"],
                  "steps": spec.get("steps", 22),
                  "cfg": spec.get("cfg", 7.0),
                  "sampler_name": spec.get("sampler", "euler_ancestral"),
                  "scheduler": spec.get("scheduler", "normal"),
                  "denoise": 1.0,
                  "model": ["1", 0],
                  "positive": ["2", 0],
                  "negative": ["3", 0],
                  "latent_image": ["4", 0],
              }},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage",
              "inputs": {"images": ["6", 0], "filename_prefix": spec.get("prefix", "qdoqmc")}},
    }
    meta = dict(spec.get("meta", {}))
    meta.update({k: spec[k] for k in ("ckpt", "pos", "neg", "width", "height", "seed",
                                     "steps", "cfg", "sampler", "scheduler") if k in spec})
    meta.setdefault("steps", spec.get("steps", 22))
    meta.setdefault("cfg", spec.get("cfg", 7.0))
    meta.setdefault("sampler", spec.get("sampler", "euler_ancestral"))
    meta.setdefault("scheduler", spec.get("scheduler", "normal"))
    meta.setdefault("loras", [])
    return {"out": spec["out"], "workflow": wf, "meta": meta}


if __name__ == "__main__":
    with open(sys.argv[1], "r", encoding="utf-8") as f:
        spec = json.load(f)
    job = build(spec)
    with open(sys.argv[2], "w", encoding="utf-8") as f:
        json.dump(job, f, ensure_ascii=False, indent=2)
    print("wrote", sys.argv[2])
