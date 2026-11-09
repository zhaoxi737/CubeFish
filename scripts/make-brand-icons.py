"""生成方块鱼品牌图标（SVG + 多尺寸 PNG + favicon + .ico）。

像素网格 19×14（18×13 图形 + 右下 1 格挤出影子），整数格对齐，
缩小时用 NEAREST 保持硬边，绝不出现抗锯齿模糊。

用法：python scripts/make-brand-icons.py
产物：
  src/renderer/assets/logo-fish.svg      矢量（顶栏/界面内）
  src/renderer/assets/logo-fish-256.png  关于页/大图标
  src/renderer/assets/favicon-64.png     index.html 用
  art/icon.ico                           窗口/安装包预留（16~256）
"""
import io
import struct
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / 'src' / 'renderer' / 'assets'
ART = ROOT / 'art'

W, H = 18, 13
CX, CY = 10.0, 6.5
RX, RY = 5.0, 3.2


def body(x, y):
    return ((x + 0.5 - CX) / RX) ** 2 + ((y + 0.5 - CY) / RY) ** 2 <= 1.0


def build_grid():
    grid = {}
    for y in range(H):
        for x in range(W):
            if body(x, y):
                grid[(x, y)] = 'l' if (y <= 4 or y >= 9) else 'g'
    for x in range(0, 6):                     # 尾鳍
        half = 3.6 * (1 - x / 6.0)
        for y in range(H):
            if abs(y + 0.5 - CY) <= half:
                grid[(x, y)] = 'd'
    for x in range(7, 11):                    # 背鳍 / 臀鳍
        grid[(x, 2)] = 'd'
        grid[(x, 10)] = 'd'
    for x in range(8, 10):
        grid[(x, 1)] = 'd'
        grid[(x, 11)] = 'd'
    for cell in [(13, 5), (13, 6)]:           # 眼睛
        grid[cell] = 'k'
    grid[(14, 7)] = 'm'                       # 嘴
    return grid


GRID = build_grid()
COLORS = {
    'g': '#5CB045',
    'l': '#9CDD6E',
    'd': '#3A7F2B',
    'k': '#141F0D',
    'm': '#141F0D',
}
SHADOW = '#26561B'


def svg() -> str:
    vw, vh = W + 1, H + 1
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" shape-rendering="crispEdges">'
        % (vw, vh, vw * 8, vh * 8)
    ]
    for (x, y) in GRID:
        out.append('<rect x="%d" y="%d" width="1" height="1" fill="%s"/>' % (x + 1, y + 1, SHADOW))
    for (x, y), key in sorted(GRID.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        out.append('<rect x="%d" y="%d" width="1" height="1" fill="%s"/>' % (x, y, COLORS[key]))
    out.append('</svg>')
    return '\n'.join(out)


def master(scale: int) -> Image.Image:
    """按整数倍渲染母版，保持像素格绝对对齐。"""
    vw, vh = W + 1, H + 1
    img = Image.new('RGBA', (vw * scale, vh * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    for (x, y) in GRID:
        d.rectangle([(x + 1) * scale, (y + 1) * scale, (x + 2) * scale - 1, (y + 2) * scale - 1], fill=SHADOW)
    for (x, y), key in GRID.items():
        d.rectangle([x * scale, y * scale, (x + 1) * scale - 1, (y + 1) * scale - 1], fill=COLORS[key])
    return img


def scaled(master_img: Image.Image, size: int) -> Image.Image:
    return master_img.resize((size, size), Image.NEAREST)


def ico_bytes(images) -> bytes:
    """手写 ICO：多尺寸 PNG 打包（Windows Vista+ 支持 PNG 压缩条目）。"""
    import io as _io

    entries = []
    for im in images:
        buf = _io.BytesIO()
        im.save(buf, format='PNG')
        entries.append((im.width, im.height, buf.getvalue()))

    header = struct.pack('<HHH', 0, 1, len(entries))
    offset = 6 + 16 * len(entries)
    directory = b''
    data = b''
    for w, h, blob in entries:
        directory += struct.pack('<BBBBHHII', w if w < 256 else 0, h if h < 256 else 0, 0, 0, 1, 32, len(blob), offset)
        offset += len(blob)
        data += blob
    return header + directory + data


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    ART.mkdir(parents=True, exist_ok=True)

    (ASSETS / 'logo-fish.svg').write_text(svg(), encoding='utf-8')
    (ROOT / 'docs' / 'ui-mockup' / 'logo-fish.svg').write_text(svg(), encoding='utf-8')

    m = master(32)                              # 608×448 母版
    scaled(m, 256).save(ASSETS / 'logo-fish-256.png')
    scaled(m, 64).save(ASSETS / 'favicon-64.png')

    sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_images = [scaled(m, s) for s in sizes]
    (ART / 'icon.ico').write_bytes(ico_bytes(ico_images))
    print('brand icons ->', ASSETS, '| ico ->', ART / 'icon.ico')
    for s in sizes:
        print('  ico', s, 'ok')


if __name__ == '__main__':
    main()
