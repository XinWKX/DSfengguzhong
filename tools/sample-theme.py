"""从任意参考图里取样主题色（当时用来确定本项目的薄荷青 #64FFDA）。

用法：
    python sample-theme.py <图片路径> [x0 y0 x1 y1]

不带区域参数时统计整幅图；带区域参数时只统计该矩形（左上角为原点）。
会输出：出现最多的彩色像素、最鲜艳 5% 的均值色、以及背景主色。

依赖 Pillow（仅此工具需要，与项目本身的零依赖无关）：
    pip install pillow
"""
import sys
import colorsys
from collections import Counter

from PIL import Image


def hsv(r, g, b):
    return colorsys.rgb_to_hsv(r / 255, g / 255, b / 255)


def hexof(rgb):
    return "#{:02X}{:02X}{:02X}".format(*rgb)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1

    path = sys.argv[1]
    rest = sys.argv[2:]
    if rest and len(rest) != 4:
        print("区域参数需要 4 个数字：x0 y0 x1 y1")
        return 1

    im = Image.open(path).convert("RGB")
    W, H = im.size
    print(f"图片: {path}  尺寸: {W} x {H}")

    box = tuple(int(v) for v in rest) if rest else (0, 0, W, H)
    x0, y0, x1, y1 = box
    x1, y1 = min(x1, W), min(y1, H)
    print(f"统计区域: ({x0}, {y0}) - ({x1}, {y1})")

    px = im.load()
    hits, ranked = Counter(), []
    for y in range(max(0, y0), y1):
        for x in range(max(0, x0), x1):
            r, g, b = px[x, y]
            h, s, v = hsv(r, g, b)
            if s >= 0.2 and v >= 0.25:          # 只统计明显有色的像素，跳过黑/白/灰
                hits[(r, g, b)] += 1
                ranked.append((s * v, (r, g, b)))

    print(f"\n彩色像素: {sum(hits.values())}")
    if not hits:
        print("  （该区域没有明显彩色像素）")
        return 0

    print("出现最多的颜色：")
    for (r, g, b), n in hits.most_common(8):
        h, s, v = hsv(r, g, b)
        print(f"  {hexof((r, g, b))}  rgb({r},{g},{b})  出现 {n:>6}  色相 {h*360:6.1f}°  饱和 {s:.2f}  明度 {v:.2f}")

    ranked.sort(reverse=True)
    top = ranked[:max(1, len(ranked) // 20)]     # 最鲜艳的 5%
    avg = tuple(sum(c[1][i] for c in top) // len(top) for i in range(3))
    h, s, v = hsv(*avg)
    print(f"\n最鲜艳 5% 均值: {hexof(avg)}  色相 {h*360:.1f}° 饱和 {s:.2f} 明度 {v:.2f}")
    print("（本项目的主题色 #64FFDA 就是这样从参考图取样得到的）")

    bg = Counter(px[x, y] for y in range(0, H, 7) for x in range(0, W, 7))
    print("\n背景最常见颜色：")
    for (r, g, b), n in bg.most_common(4):
        print(f"  {hexof((r, g, b))}  出现 {n}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
