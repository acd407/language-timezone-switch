#!/usr/bin/env python3
"""生成扩展图标（纯几何图形，不依赖字体）。

用法： python3 tools/make-icons.py
输出： icons/icon-{16,32,48,96,128}.png
"""

import os
from PIL import Image, ImageDraw

SIZES = (16, 32, 48, 96, 128)
BASE = 512
BG_TOP = (46, 122, 214)
BG_BOTTOM = (18, 74, 156)
FG = (255, 255, 255)


def rounded_mask(size: int, radius: float) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background(size: int) -> Image.Image:
    grad = Image.new("RGB", (1, size))
    for y in range(size):
        t = y / (size - 1)
        grad.putpixel(
            (0, y),
            (
                round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * t),
                round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * t),
                round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * t),
            ),
        )
    bg = grad.resize((size, size))
    bg.putalpha(rounded_mask(size, size * 0.22))
    return bg


def draw_globe(image: Image.Image) -> None:
    size = image.width
    draw = ImageDraw.Draw(image)
    c = size / 2
    r = size * 0.30
    w = max(1, round(size * 0.055))

    # 外圈
    draw.ellipse((c - r, c - r, c + r, c + r), outline=FG, width=w)
    # 经线
    draw.ellipse((c - r * 0.5, c - r, c + r * 0.5, c + r), outline=FG, width=w)
    # 赤道
    draw.line((c - r, c, c + r, c), fill=FG, width=w)


def main() -> None:
    out_dir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
    os.makedirs(out_dir, exist_ok=True)

    master = background(BASE)
    draw_globe(master)

    for size in SIZES:
        resized = master.resize((size, size), Image.LANCZOS)
        path = os.path.join(out_dir, f"icon-{size}.png")
        resized.save(path, optimize=True)
        print("wrote", path)


if __name__ == "__main__":
    main()
