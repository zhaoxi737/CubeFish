import json
import os
TOOLS = r"D:\QDOQMC\art\_tools"
specs = [
    {
        "ckpt": "anything-v5-PrtRE.safetensors",
        "pos": ("green grass texture, top view, pixel art, 16-bit, seamless tileable background, "
                "flat grass field, uniform small grass pixels, bright green with darker green tufts, "
                "background texture, evenly distributed, no objects, no text"),
        "neg": ("text, watermark, signature, blurry, photo, 3d render, realistic, jpeg artifacts, cube, "
                "isometric, 3d block, object, icon, border, frame, blank margins, perspective, horizon, "
                "landscape, terrain, ring, circle, diamond, logo, centered object, single object"),
        "width": 512, "height": 512, "seed": 20261050,
        "steps": 24, "cfg": 7.0, "sampler": "euler_ancestral", "scheduler": "normal",
        "prefix": "qdoqmc_tile",
        "out": "D:\\QDOQMC\\art\\_tools\\test_tile5.png",
    },
    {
        "ckpt": "majicmix7.safetensors",
        "pos": ("top down view of a lush green lawn, seamless grass texture, flat even lighting, "
                "dense grass blades, natural green, no objects, background texture"),
        "neg": ("text, watermark, signature, blurry, photo, 3d render, jpeg artifacts, cube, isometric, "
                "object, person, animal, flower pot, shadow, frame, border, horizon, perspective"),
        "width": 512, "height": 512, "seed": 20261051,
        "steps": 24, "cfg": 6.5, "sampler": "euler_ancestral", "scheduler": "normal",
        "prefix": "qdoqmc_tile",
        "out": "D:\\QDOQMC\\art\\_tools\\test_tile6.png",
    },
    {
        "ckpt": "anything-v5-PrtRE.safetensors",
        "pos": ("three pixel art game ui icons arranged in a row, download arrow icon, settings gear icon, "
                "puzzle piece icon, flat 16-bit icons, blocky, crisp pixels, deepseek blue and dark navy "
                "palette, dark background, centered grid, no text"),
        "neg": ("text, watermark, letters, numbers, blurry, photo, realistic, 3d render, jpeg artifacts, "
                "many icons, clutter, minecraft blocks, grass, items, inventory"),
        "width": 640, "height": 640, "seed": 20261052,
        "steps": 24, "cfg": 7.0, "sampler": "euler_ancestral", "scheduler": "normal",
        "prefix": "qdoqmc_icon",
        "out": "D:\\QDOQMC\\art\\_tools\\test_icon2.png",
    },
]
json.dump(specs, open(os.path.join(TOOLS, "specs_batch.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=2)
print("wrote", len(specs))
