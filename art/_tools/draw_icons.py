"""Procedurally draw the QDOQMC pixel icon pack (download / mods / settings).

Pixel grid: each icon is 40x40 logical pixels, scaled x8 to 320x320 tiles.
Colours: DeepSeek blue #4d6bfe + dark slate tile background.
"""
import random

from PIL import Image, ImageDraw

BLOCK = 8
LOG = 40
TILE = LOG * BLOCK  # 320
GAP = 48
MARGIN = 48
SHEET_W = MARGIN * 2 + TILE * 3 + GAP * 2
SHEET_H = TILE + MARGIN * 2  # 416 -> pad to 384? keep computed

BG_TILE = (26, 31, 48, 255)
BG_TILE2 = (32, 38, 60, 255)
BORDER = (47, 58, 94, 255)
BLUE = (77, 107, 254, 255)
BLUE_LIGHT = (142, 162, 255, 255)
WHITE = (232, 236, 255, 255)
DARK = (18, 22, 34, 255)


def rnd(seed=7):
    return random.Random(seed)


def base_tile(rng):
    im = Image.new("RGBA", (LOG, LOG), BG_TILE)
    d = ImageDraw.Draw(im)
    # subtle pixel noise
    for y in range(0, LOG, 2):
        for x in range(0, LOG, 2):
            if rng.random() < 0.16:
                d.rectangle([x, y, x + 1, y + 1], fill=BG_TILE2)
    # 1px border + inner corner notches
    d.rectangle([0, 0, LOG - 1, LOG - 1], outline=BORDER)
    for (x, y) in ((0, 0), (LOG - 2, 0), (0, LOG - 2), (LOG - 2, LOG - 2)):
        d.rectangle([x, y, x + 1, y + 1], fill=DARK)
    return im


def icon_download(d):
    d.rectangle([18, 7, 21, 21], fill=BLUE)          # shaft
    d.rectangle([13, 21, 26, 24], fill=BLUE)         # head top bar
    d.rectangle([16, 24, 23, 26], fill=BLUE)
    d.rectangle([18, 26, 21, 28], fill=BLUE)         # tip
    d.rectangle([9, 25, 11, 33], fill=BLUE_LIGHT)    # tray left
    d.rectangle([28, 25, 30, 33], fill=BLUE_LIGHT)   # tray right
    d.rectangle([9, 31, 30, 33], fill=BLUE_LIGHT)    # tray bottom
    d.rectangle([9, 25, 30, 26], fill=BLUE_LIGHT)
    d.rectangle([9, 31, 30, 32], fill=BLUE_LIGHT)


def icon_mods(d):
    # blocky puzzle piece
    d.rectangle([10, 13, 29, 30], fill=BLUE)
    d.rectangle([16, 8, 23, 13], fill=BLUE)          # top knob
    d.rectangle([29, 17, 34, 24], fill=BLUE)         # right knob
    d.rectangle([10, 13, 29, 15], fill=BLUE_LIGHT)   # top highlight
    d.rectangle([10, 13, 11, 30], fill=BLUE_LIGHT)
    d.rectangle([17, 18, 22, 23], fill=DARK)         # puzzle notch
    d.rectangle([6, 6, 8, 8], fill=BLUE_LIGHT)       # sparkle pixels
    d.rectangle([31, 8, 33, 10], fill=BLUE_LIGHT)


def icon_gear(d):
    # 4 cardinal teeth + ring + hub
    teeth = [(17, 5, 22, 8), (17, 32, 22, 35), (5, 17, 8, 22), (32, 17, 35, 22)]
    for t in teeth:
        d.rectangle(list(t), fill=BLUE)
    d.rectangle([9, 9, 31, 31], fill=BLUE)            # body
    d.rectangle([13, 13, 27, 27], fill=BG_TILE)       # ring inner
    d.rectangle([17, 17, 23, 23], fill=BLUE_LIGHT)    # hub
    d.rectangle([19, 19, 21, 21], fill=DARK)          # hub hole
    # diagonal teeth blocks
    for (x, y) in ((11, 11), (28, 11), (11, 28), (28, 28)):
        d.rectangle([x, y, x + 2, y + 2], fill=BLUE)
    # rim highlight
    d.rectangle([9, 9, 31, 10], fill=BLUE_LIGHT)
    d.rectangle([9, 9, 10, 31], fill=BLUE_LIGHT)


def main():
    rng = rnd()
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    drawers = [icon_download, icon_mods, icon_gear]
    for i, fn in enumerate(drawers):
        tile = base_tile(rnd(11 + i))
        d = ImageDraw.Draw(tile)
        fn(d)
        tile = tile.resize((TILE, TILE), Image.NEAREST)
        sheet.alpha_composite(tile, (MARGIN + i * (TILE + GAP), MARGIN))
    sheet.save(r"D:\QDOQMC\art\_tools\iconpack.png", "PNG", optimize=True)
    print("saved", sheet.size, "bytes", __import__("os").path.getsize(r"D:\QDOQMC\art\_tools\iconpack.png"))


if __name__ == "__main__":
    main()
