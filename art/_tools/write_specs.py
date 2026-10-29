import json

BASE = {
    "ckpt": "anything-v5-PrtRE.safetensors",
    "width": 640,
    "height": 640,
    "steps": 24,
    "cfg": 7.0,
    "sampler": "euler_ancestral",
    "scheduler": "normal",
}

jobs = []

tile_pos = ("top down view, seamless tileable texture, pixel art grass block surface, 16-bit, "
            "Minecraft style, flat shading, repeating pattern, no shadows, no perspective, no text, "
            "full frame dense grass, uniform small pixel details, evenly distributed, fills entire image")
tile_neg = ("text, watermark, signature, blurry, photo, 3d render, realistic, jpeg artifacts, cube, "
            "isometric, 3d block, perspective, shadow, border, frame, letterbox, blank margins, "
            "white background, gradient, high contrast, ring, circle, logo, object")

for i, seed in enumerate((20261033, 20261034), start=1):
    jobs.append(dict(BASE, pos=tile_pos, neg=tile_neg, seed=seed,
                     prefix="qdoqmc_tile", out=f"D:\\QDOQMC\\art\\_tools\\test_tile3_{i}.png"))

jobs.append(dict(BASE, width=640, height=640, seed=20261035,
                 pos=("pixel art icon set, three separate square icons arranged horizontally, "
                      "download arrow icon, puzzle piece mod icon, gear settings icon, minecraft style, "
                      "16-bit, blocky, flat shading, crisp pixels, deepseek blue and dark navy palette, "
                      "on dark slate background, centered, no text"),
                 neg=("text, watermark, letters, numbers, blurry, photo, realistic, 3d render, "
                      "jpeg artifacts, many icons, clutter, noise"),
                 prefix="qdoqmc_icon", out="D:\\QDOQMC\\art\\_tools\\test_icon.png"))

with open("D:\\QDOQMC\\art\\_tools\\specs_batch.json", "w", encoding="utf-8") as f:
    json.dump(jobs, f, ensure_ascii=False, indent=2)
print("wrote", len(jobs), "specs")
