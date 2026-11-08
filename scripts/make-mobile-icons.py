"""方块鱼 Android 图标生成器：从 art/mascot-fish.png 生成各密度 launcher 图标（webp）。

用法：python scripts/make-mobile-icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / "art" / "mascot-fish.png"
RES = Path(r"D:\CubeFish-Mobile\amethyst\app_pojavlauncher\src\main\res")

# 各密度：legacy 48dp / adaptive 108dp
DENSITIES = {
    "mdpi": 1.0,
    "hdpi": 1.5,
    "xhdpi": 2.0,
    "xxhdpi": 3.0,
    "xxxhdpi": 4.0,
}

BG_TOP = (13, 20, 30)
BG_BOTTOM = (24, 40, 66)
ACCENT = (77, 107, 254)
GREEN = (126, 217, 87)


def load_fish() -> Image.Image:
    fish = Image.open(SRC).convert("RGBA")
    bbox = fish.getbbox()
    if bbox:
        fish = fish.crop(bbox)
    return fish


def fit(fish: Image.Image, box: int) -> Image.Image:
    w, h = fish.size
    scale = min(box / w, box / h)
    return fish.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)


def gradient(size: int) -> Image.Image:
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        t = y / max(1, size - 1)
        color = tuple(int(BG_TOP[i] + (BG_BOTTOM[i] - BG_TOP[i]) * t) for i in range(3))
        for x in range(size):
            px[x, y] = color
    # 左下角一抹蓝光，右上角一抹草绿 —— 和桌面版的主题呼应
    glow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(glow)
    draw.ellipse((-size * 0.35, size * 0.55, size * 0.55, size * 1.45), fill=(*ACCENT, 70))
    draw.ellipse((size * 0.55, -size * 0.3, size * 1.35, size * 0.5), fill=(*GREEN, 45))
    glow = glow.filter(ImageFilter.GaussianBlur(size * 0.08))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    return img


def foreground(size: int, fish: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    # adaptive foreground 的安全区约 66%
    f = fit(fish, int(size * 0.62))
    x = (size - f.width) // 2
    y = (size - f.height) // 2
    # 柔和投影，避免图标糊在背景上
    shadow = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow_fish = Image.new("RGBA", f.size, (0, 0, 0, 0))
    shadow_fish.paste((0, 0, 0, 120), (0, 0), f)
    shadow.paste(shadow_fish, (x, y + int(size * 0.03)), shadow_fish)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.02))
    canvas = Image.alpha_composite(canvas, shadow)
    canvas.paste(f, (x, y), f)
    return canvas


def monochrome(size: int, fish: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    f = fit(fish, int(size * 0.62))
    white = Image.new("RGBA", f.size, (0, 0, 0, 0))
    alpha = f.getchannel("A")
    white.paste((255, 255, 255, 255), (0, 0), alpha)
    canvas.paste(white, ((size - f.width) // 2, (size - f.height) // 2), white)
    return canvas


def rounded_legacy(size: int, fish: Image.Image) -> Image.Image:
    bg = gradient(size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * 0.22), fill=255)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    f = fit(fish, int(size * 0.66))
    icon.paste(f, ((size - f.width) // 2, (size - f.height) // 2), f)
    return icon


def round_legacy(size: int, fish: Image.Image) -> Image.Image:
    bg = gradient(size).convert("RGBA")
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    icon = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    icon.paste(bg, (0, 0), mask)
    f = fit(fish, int(size * 0.62))
    icon.paste(f, ((size - f.width) // 2, (size - f.height) // 2), f)
    return icon


def save(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "WEBP", quality=92, method=6)
    print(f"  {path.relative_to(RES)}  {img.width}x{img.height}")


def main() -> None:
    fish = load_fish()
    for density, scale in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        save(rounded_legacy(int(48 * scale), fish), folder / "ic_launcher.webp")
        save(round_legacy(int(48 * scale), fish), folder / "ic_launcher_round.webp")
        save(gradient(int(108 * scale)), folder / "ic_launcher_background.webp")
        save(foreground(int(108 * scale), fish), folder / "ic_launcher_foreground.webp")
    save(monochrome(432, fish), RES / "drawable" / "ic_launcher_monochrome.webp")

    # 自适应图标背景色（部分 ROM 会用它兜底）
    (RES / "values" / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#0D141E</color>\n</resources>\n',
        encoding="utf-8",
    )
    print("done")


if __name__ == "__main__":
    main()
