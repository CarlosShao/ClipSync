#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""图标验证：尺寸、画布无圆角（四角不透明）、品牌色存在性。"""

import os
import glob
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.abspath(os.path.join(HERE, "..", "图标"))

EXPECT_PURPLE = (0x7C, 0x6C, 0xF0)
EXPECT_INK = (0x14, 0x14, 0x14)


def close(a, b, tol=6):
    return all(abs(x - y) <= tol for x, y in zip(a[:3], b[:3]))


def check_set(files, label):
    print(f"\n### {label}  ({len(files)} files)")
    print(f"{'file':34} {'WxH':10} {'mode':5} {'square':7} {'canvas_no_round':16} "
          f"{'purple':7} {'ink':5}")
    print("-" * 86)
    all_ok = True
    for f in files:
        name = os.path.basename(f)
        im = Image.open(f)
        w, h = im.size
        rgba = im.convert("RGBA")

        square = (w == h)
        # 画布级无圆角判定：四角像素必须**完全不透明**（alpha=255）。
        # 若对画布切了圆角，四角 alpha 会是 0 —— 商店会拒收带透明通道的方图。
        corners = [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]
        canvas_opaque = all(rgba.getpixel(c)[3] == 255 for c in corners)

        # 品牌色存在性
        colors = rgba.convert("RGB").getcolors(maxcolors=w * h)
        has_purple = any(close(c, EXPECT_PURPLE) for _, c in (colors or []))
        has_ink = any(close(c, EXPECT_INK) for _, c in (colors or []))

        ok = square and canvas_opaque and has_purple and has_ink
        all_ok = all_ok and ok

        print(f"{name:34} {f'{w}x{h}':10} {im.mode:5} {str(square):7} "
              f"{str(canvas_opaque):16} {str(has_purple):7} {str(has_ink):5}")
    return all_ok


def main():
    primary = sorted(
        glob.glob(os.path.join(ICON_DIR, "ic_launcher_*x*.png")),
        key=lambda p: int(os.path.basename(p).split("_")[-1].split("x")[0]),
    )
    fullbleed = sorted(
        glob.glob(os.path.join(ICON_DIR, "满幅备选", "*.png")),
        key=lambda p: int(os.path.basename(p).rsplit("_", 1)[-1].split("x")[0]),
    )

    ok1 = check_set(primary, "主产物（商店提交用 · 留白版）")
    ok2 = check_set(fullbleed, "备选（满幅版）")

    print("\n" + "=" * 86)
    if ok1 and ok2:
        print("ALL CHECKS PASSED")
        return 0
    print("*** SOME CHECKS FAILED ***")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
