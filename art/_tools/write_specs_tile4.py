import json
import os
TOOLS = r"D:\QDOQMC\art\_tools"
specs = []
pos = ("seamless tileable grass texture, top down view, pixel art, 16-bit, minecraft grass block top, "
       "full frame green grass, uniform small pixel details, repeating pattern, flat shading, "
       "no shadows, no perspective, no text, no objects")
neg = ("text, watermark, signature, blurry, photo, 3d render, realistic, jpeg artifacts, cube, isometric, "
       "3d block, object, icon, border, frame, letterbox, blank margins, white background, gradient, "
       "high contrast, ring, circle, logo, single object, centered")
for seed in (20261040, 20261041, 20261042):
    specs.append({
        "ckpt": "anything-v5-PrtRE.safetensors",
        "pos": pos, "neg": neg,
        "width": 512, "height": 512, "seed": seed,
        "steps": 24, "cfg": 7.0,
        "sampler": "euler_ancestral", "scheduler": "normal",
        "prefix": "qdoqmc_tile",
        "out": f"D:\\QDOQMC\\art\\_tools\\test_tile4_{seed}.png",
    })
json.dump(specs, open(os.path.join(TOOLS, "specs_batch.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("wrote", len(specs))
