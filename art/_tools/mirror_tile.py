"""Build mirror-tiled seamless variant from a pixel texture."""
import sys
import numpy as np
from PIL import Image

MC_RAMP = ["#2f4f1a", "#3a5f20", "#466f27", "#527f2e", "#5e8f35", "#6a9f3d",
           "#76af45", "#82bf4e", "#8fcf58", "#9adf62"]


def hexc(c):
    return tuple(int(c[i:i + 2], 16) for i in (1, 3, 5))


def palette_map(im, colors):
    q = im.quantize(colors=colors, method=Image.MEDIANCUT, dither=Image.NONE)
    pal = q.getpalette()
    idx = np.asarray(q)
    used = [i for i in range(colors) if (idx == i).any()]
    used.sort(key=lambda i: 0.299 * pal[i * 3] + 0.587 * pal[i * 3 + 1] + 0.114 * pal[i * 3 + 2])
    if len(used) == 1:
        return q.convert("RGB")
    ramp = [hexc(c) for c in MC_RAMP]
    out = np.zeros((idx.shape[0], idx.shape[1], 3), dtype=np.uint8)
    for rank, i in enumerate(used):
        pos = rank / (len(used) - 1) * (len(ramp) - 1)
        lo = int(np.floor(pos))
        hi = min(lo + 1, len(ramp) - 1)
        t = pos - lo
        col = tuple(int(ramp[lo][k] * (1 - t) + ramp[hi][k] * t) for k in range(3))
        out[idx == i] = col
    return Image.fromarray(out, "RGB")


def main(src, dest, px=128, colors=8):
    im = Image.open(src).convert("RGB")
    a = im.resize((px, px), Image.BOX)
    a = palette_map(a, colors)
    arr = np.asarray(a)
    top = np.concatenate([arr, arr[:, ::-1]], axis=1)
    bot = np.concatenate([arr[::-1, :], arr[::-1, ::-1]], axis=1)
    b = np.concatenate([top, bot], axis=0)
    out = Image.fromarray(b, "RGB").resize((512, 512), Image.NEAREST)
    out.save(dest, "PNG", optimize=True)
    print("mirror tile:", dest, out.size)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv) > 3 else 128,
         int(sys.argv[4]) if len(sys.argv) > 4 else 8)
