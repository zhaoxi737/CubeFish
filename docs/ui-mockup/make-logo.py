"""方块鱼 logo（Minecraft 像素方块风）v3。

16x12 像素网格：椭圆鱼身 + 三角尾鳍 + 背鳍/臀鳍 + 方眼睛 + 嘴。
顶亮 / 身中 / 底暗，右下 1 格挤出影子做出方块厚度。
先在控制台打印 ASCII 自检，再输出 SVG。
"""
import io
import math

W, H = 18, 13
grid = {}

CX, CY = 10.0, 6.5          # 鱼身中心
RX, RY = 5.0, 3.2           # 鱼身半径

def body(x, y):
    return ((x + 0.5 - CX) / RX) ** 2 + ((y + 0.5 - CY) / RY) ** 2 <= 1.0

# ---- 鱼身 ----
for y in range(H):
    for x in range(W):
        if body(x, y):
            if y <= 4:
                grid[(x, y)] = 'l'      # 上部受光
            elif y >= 9:
                grid[(x, y)] = 'l'      # 肚子也亮一档
            else:
                grid[(x, y)] = 'g'

# ---- 尾鳍：x=0 处最宽，往鱼身收窄 ----
for x in range(0, 6):
    half = 3.6 * (1 - x / 6.0)
    for y in range(H):
        if abs(y + 0.5 - CY) <= half:
            grid[(x, y)] = 'd'

# ---- 背鳍 / 臀鳍（贴住身体，不留缝）----
for x in range(7, 11):
    grid[(x, 2)] = 'd'
    grid[(x, 10)] = 'd'
for x in range(8, 10):
    grid[(x, 1)] = 'd'
    grid[(x, 11)] = 'd'

# ---- 眼睛（2x2 方块眼，放在身体内缘）----
for cell in [(13, 5), (13, 6)]:
    grid[cell] = 'k'

# ---- 嘴（头部前下方一格，贴着轮廓）----
grid[(14, 7)] = 'm'

# ---- 打印 ASCII 自检 ----
for y in range(H):
    print(''.join(grid.get((x, y), '.') for x in range(W)))

COLORS = {
    'g': '#5CB045',
    'l': '#9CDD6E',
    'd': '#3A7F2B',
    'k': '#141F0D',
    'm': '#141F0D',
}

def main():
    out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %d %d" width="%d" height="%d" shape-rendering="crispEdges">'
           % (W + 1, H + 1, (W + 1) * 8, (H + 1) * 8)]
    for (x, y) in grid:
        out.append('<rect x="%d" y="%d" width="1" height="1" fill="#26561B"/>' % (x + 1, y + 1))
    for (x, y), key in sorted(grid.items(), key=lambda kv: (kv[0][1], kv[0][0])):
        out.append('<rect x="%d" y="%d" width="1" height="1" fill="%s"/>' % (x, y, COLORS[key]))
    out.append('</svg>')
    io.open(r'D:\QDOQMC\docs\ui-mockup\logo-fish.svg', 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
    print('cells=%d' % len(grid))

main()
