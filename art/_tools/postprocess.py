"""PIL/numpy post-processing for QDOQMC art assets (no new dependencies)."""
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter


def mascot_alpha(src, dest):
    im = Image.open(src).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    r, g, b = a[..., 0], a[..., 1], a[..., 2]
    mx = a.max(axis=2)
    mn = a.min(axis=2)
    whiteish = (mn > 238) & ((mx - mn) < 12)

    # flood fill from the four corners over the whiteish mask
    from scipy.ndimage import label
    lab, n = label(whiteish)
    h, w = lab.shape
    corner_labels = {int(lab[0, 0]), int(lab[0, w - 1]), int(lab[h - 1, 0]), int(lab[h - 1, w - 1])}
    corner_labels.discard(0)
    bg = np.isin(lab, list(corner_labels))

    alpha = np.where(bg, 0, 255).astype(np.float32)

    # 1px feather on the silhouette edge: bright edge pixels get lower alpha
    fg = ~bg
    fg_img = Image.fromarray((fg * 255).astype(np.uint8), "L")
    er = np.asarray(fg_img.filter(ImageFilter.MinFilter(3))) > 0  # eroded foreground
    edge = fg & ~er
    lum = (0.299 * r + 0.587 * g + 0.114 * b)
    # near-white edge pixels are anti-aliasing halo -> more transparent (min 180)
    edge_alpha = np.clip(255 - (lum - 195) * 1.6, 180, 255)
    alpha[edge] = edge_alpha[edge]

    # soft 1px gaussian feather of the alpha to avoid hard jaggies
    alpha = np.asarray(Image.fromarray(alpha.astype(np.uint8), "L").filter(ImageFilter.GaussianBlur(0.6))).astype(np.float32)
    alpha[bg] = np.minimum(alpha[bg], 40)
    alpha[alpha < 12] = 0

    rgba = np.dstack([a.astype(np.uint8), alpha.astype(np.uint8)])
    out = Image.fromarray(rgba, "RGBA")
    out.save(dest, "PNG", optimize=True)
    print("mascot:", dest, out.size, os.path.getsize(dest), "bytes",
          "bg px:", int(bg.sum()), "edge px:", int(edge.sum()))


def bg_hero(src, dest):
    im = Image.open(src).convert("RGB")
    arr = np.asarray(im).astype(np.float32)

    # desaturate + compress contrast
    lum = arr.mean(axis=2, keepdims=True)
    arr = lum + (arr - lum) * 0.72
    arr = 128 + (arr - 128) * 0.82

    # darken overall and keep the left third extra dark for white UI text
    x = np.linspace(0.0, 1.0, arr.shape[1])[None, :, None]
    left_dark = 0.52 + 0.48 * np.clip((x - 0.02) / 0.62, 0, 1) ** 1.4
    arr = arr * left_dark

    # cool navy tint, then vignette
    navy = np.array([16, 24, 58], dtype=np.float32)[None, None, :]
    arr = arr * 0.86 + navy * 0.14
    yy, xx = np.mgrid[0:arr.shape[0], 0:arr.shape[1]]
    cx, cy = arr.shape[1] / 2, arr.shape[0] / 2
    d = np.sqrt(((xx - cx) / cx) ** 2 + ((yy - cy) / cy) ** 2)
    vig = np.clip(1.0 - 0.22 * np.clip(d - 0.55, 0, 2) ** 1.2, 0.72, 1.0)[..., None]
    arr = arr * vig

    arr = np.clip(arr, 0, 255).astype(np.uint8)
    out = Image.fromarray(arr, "RGB")
    out.save(dest, "PNG", optimize=True)
    print("bg:", dest, out.size, os.path.getsize(dest), "bytes")


def _wrap_blend(arr, n):
    """Make low-res pixel texture periodic by mirror-blending n pixels at each seam."""
    a = arr.astype(np.float32).copy()
    h, w = a.shape[:2]
    for i in range(n):
        t = 0.5 * (1.0 - i / n)
        # left vs right
        l = a[:, i].copy()
        r = a[:, w - 1 - i].copy()
        a[:, i] = (1 - t) * l + t * r
        a[:, w - 1 - i] = (1 - t) * r + t * l
        # top vs bottom
        u = a[i, :].copy()
        d = a[h - 1 - i, :].copy()
        a[i, :] = (1 - t) * u + t * d
        a[h - 1 - i, :] = (1 - t) * d + t * u
    return a


def tile_grass(src, dest, px=128, colors=10, blend=2, sat=0.88, out=512):
    im = Image.open(src).convert("RGB")
    small = im.resize((px, px), Image.BOX)
    small = small.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    arr = np.asarray(small).astype(np.float32)
    # desaturate a touch so it does not glare behind launcher UI
    lum = arr.mean(axis=2, keepdims=True)
    arr = lum + (arr - lum) * sat
    arr = np.clip(_wrap_blend(arr, blend), 0, 255)
    small2 = Image.fromarray(arr.astype(np.uint8), "RGB")
    small2 = small2.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE).convert("RGB")
    big = small2.resize((out, out), Image.NEAREST)
    big.save(dest, "PNG", optimize=True)
    print("tile:", dest, big.size, os.path.getsize(dest), "bytes; px=%d colors=%d blend=%d" % (px, colors, blend))
    return big


MC_RAMP = ["#2f4f1a", "#3a5f20", "#466f27", "#527f2e", "#5e8f35", "#6a9f3d",
           "#76af45", "#82bf4e", "#8fcf58", "#9adf62"]


def _hex(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def _palette_map(im, colors, ramp=MC_RAMP):
    """Quantize then remap the palette onto a Minecraft-grass green ramp by luminance rank."""
    q = im.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    pal = q.getpalette()
    idx = np.asarray(q)
    used = [i for i in range(colors) if (idx == i).any()]
    used.sort(key=lambda i: 0.299 * pal[i * 3] + 0.587 * pal[i * 3 + 1] + 0.114 * pal[i * 3 + 2])
    if len(used) == 1:
        return q.convert("RGB")
    ramp_rgb = [_hex(c) for c in ramp]
    lut = {}
    for rank, i in enumerate(used):
        pos = rank / (len(used) - 1) * (len(ramp_rgb) - 1)
        lo = int(np.floor(pos))
        hi = min(lo + 1, len(ramp_rgb) - 1)
        t = pos - lo
        col = tuple(int(ramp_rgb[lo][k] * (1 - t) + ramp_rgb[hi][k] * t) for k in range(3))
        lut[i] = col
    out = np.zeros((idx.shape[0], idx.shape[1], 3), dtype=np.uint8)
    for i, col in lut.items():
        out[idx == i] = col
    return Image.fromarray(out, "RGB")


def tile_minecraft(src, dest, px=128, colors=8, blend=2, out=512):
    im = Image.open(src).convert("RGB")
    small = im.resize((px, px), Image.BOX)
    arr = _wrap_blend(np.asarray(small).astype(np.float32), blend)
    small = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")
    small = _palette_map(small, colors)
    big = small.resize((out, out), Image.NEAREST)
    big.save(dest, "PNG", optimize=True)
    print("tile:", dest, big.size, os.path.getsize(dest), "bytes; px=%d colors=%d blend=%d" % (px, colors, blend))
    return big


def tile_periodic(src, dest, px=128, colors=8, out=512):
    """Periodize a texture with a 2D 4-copy cosine overlap so the result tiles exactly."""
    im = Image.open(src).convert("RGB")
    small = im.resize((px, px), Image.BOX)
    small = _palette_map(small, colors)
    a = np.asarray(small).astype(np.float32)
    h, w = a.shape[:2]
    x = np.arange(w)[None, :, None]
    y = np.arange(h)[:, None, None]
    prof_x = 0.5 * (1 - np.cos(2 * np.pi * x / w))       # 0 at x=0, 1 at x=w/2
    prof_y = 0.5 * (1 - np.cos(2 * np.pi * y / h))
    wx0, wx1 = prof_x, 1 - prof_x
    wy0, wy1 = prof_y, 1 - prof_y
    out_arr = np.zeros_like(a, dtype=np.float32)
    for sx, wxs in ((0, wx0), (w // 2, wx1)):
        for sy, wys in ((0, wy0), (h // 2, wy1)):
            rolled = np.roll(np.roll(a, -sy, axis=0), -sx, axis=1)
            out_arr += wxs * wys * rolled
    out_arr = np.clip(out_arr, 0, 255).astype(np.uint8)
    small2 = _palette_map(Image.fromarray(out_arr, "RGB"), colors)
    big = small2.resize((out, out), Image.NEAREST)
    big.save(dest, "PNG", optimize=True)
    print("periodic tile:", dest, big.size, os.path.getsize(dest), "bytes; px=%d colors=%d" % (px, colors))
    return big


def tile_preview(src, dest, n=3):
    im = Image.open(src).convert("RGB")
    w, h = im.size
    canvas = Image.new("RGB", (w * n, h * n))
    for i in range(n):
        for j in range(n):
            canvas.paste(im, (i * w, j * h))
    canvas.save(dest, "PNG")
    print("tile preview:", dest, canvas.size)


if __name__ == "__main__":
    cmd = sys.argv[1]
    if cmd == "mascot":
        mascot_alpha(sys.argv[2], sys.argv[3])
    elif cmd == "bg":
        bg_hero(sys.argv[2], sys.argv[3])
    elif cmd == "tilepreview":
        tile_preview(sys.argv[2], sys.argv[3], int(sys.argv[4]) if len(sys.argv) > 4 else 3)
    elif cmd == "tile":
        tile_grass(sys.argv[2], sys.argv[3],
                   px=int(sys.argv[4]) if len(sys.argv) > 4 else 128,
                   colors=int(sys.argv[5]) if len(sys.argv) > 5 else 10,
                   blend=int(sys.argv[6]) if len(sys.argv) > 6 else 2)
    elif cmd == "tilemc":
        tile_minecraft(sys.argv[2], sys.argv[3],
                       px=int(sys.argv[4]) if len(sys.argv) > 4 else 128,
                       colors=int(sys.argv[5]) if len(sys.argv) > 5 else 8,
                       blend=int(sys.argv[6]) if len(sys.argv) > 6 else 2)
    elif cmd == "tileperiodic":
        tile_periodic(sys.argv[2], sys.argv[3],
                      px=int(sys.argv[4]) if len(sys.argv) > 4 else 128,
                      colors=int(sys.argv[5]) if len(sys.argv) > 5 else 8)
