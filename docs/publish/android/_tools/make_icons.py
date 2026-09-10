#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ClipSync 上架图标生成器（国内安卓应用商店材料 1）

保真复刻官网品牌视觉（不自行设计）：
  来源 1：src/website/public/favicon.svg       —— "通道 Gate" 定稿 logo（深底 + 白柱 + 紫点）
  来源 2：src/website/index.html 第 39/262 行     —— 导航 logo-mark（同几何，白色双柱 + #7c6cf0 紫点）

原始 48x48 viewBox 几何（逐字照抄，勿改）：
  <rect width="48" height="48" rx="11" fill="#141414"/>            <- 仅 favicon.svg 有底
  <rect x="9.8"  y="10.5" width="5" height="19" rx="2.5" fill="#fff"/>
  <rect x="33.2" y="18.5" width="5" height="19" rx="2.5" fill="#fff"/>
  <rect x="20.9" y="19.5" width="9" height="9"  rx="2.6" fill="#7c6cf0"/>
  <line x1="16.4" y1="26" x2="18.6" y2="24.7" stroke="#7c6cf0" stroke-width="3.4"
        stroke-linecap="round" opacity=".55"/>

生成物：512/216/192/180/144/96 正方形 PNG，外层画布**无圆角且完全不透明**
（商店要求方图；圆角/异形裁切由各商店客户端自行完成，提交物必须是实心方图）。

两种底色变体：
  - 多数商店（华为/小米/vivo/OPPO 的应用图标位）：圆角留白版
      画布 = #141414 实心方形，logo 几何按原比例缩到 ~76% 居中。
      这样商店自己裁圆角时不会切到图形本体。
  - 备选：满幅版（logo 铺满，含圆角底）—— 见 --fullbleed

用法：python make_icons.py
"""

import os
from PIL import Image, ImageDraw

# ── 品牌色（来自源码，勿自创） ────────────────────────────────────────────────
BG_INK = "#141414"      # tokens.css --ink / favicon.svg 底色
PURPLE = "#7c6cf0"      # logo 紫点主色
WHITE = "#ffffff"       # 双柱

# 源码 viewBox 尺寸
VB = 48.0

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "图标")
SIZES = [512, 216, 192, 180, 144, 96]

# 超采样倍数：先在 4x 画布绘制再降采样，得到平滑边缘（PIL 无原生 SVG 抗锯齿）
SS = 4
SS_BASE = 4096


def draw_mark(img_size, fullbleed=False):
    """按源码几何绘制 logo。

    默认（fullbleed=False，商店提交用）：
      - 画布是 **完全不透明的 #141414 实心正方形**（四角 alpha=255，无圆角）
      - logo 图形本体按 ~76% 居中绘制，外圈留出安全边距
        （商店客户端自己裁圆角/圆形时不会切到双柱与紫点）

    fullbleed=True（备选）：
      - 画布仍是不透明方形，但 logo 图形铺满整幅
      - 适用于需要满幅图的自定义场景；不推荐直接提交各商店图标位
    """
    s = img_size / VB  # viewBox 单位 -> 像素
    img = Image.new("RGBA", (img_size, img_size), (0x14, 0x14, 0x14, 255))
    d = ImageDraw.Draw(img)

    if fullbleed:
        scale, off = 1.0, 0.0
    else:
        # 0.76 缩放 + 居中：等价于 Android adaptive icon 的 108dp 画布 / 72dp 安全区比例
        scale = 0.76
        off = (1.0 - scale) / 2.0

    def px(v):
        # viewBox 单位（含缩放/居中偏移）-> 像素
        return (off * VB + v * scale) * s

    def sz(v):
        return v * scale * s

    # 1) 图形底：满幅版用源码 rx=11 的圆角方块；留白版画布已是实心墨色，无需再画。
    if fullbleed:
        d.rounded_rectangle(
            [0, 0, img_size - 1, img_size - 1],
            radius=sz(11),
            fill=BG_INK,
        )

    # 2) 左柱 x=9.8 y=10.5 w=5 h=19 rx=2.5
    d.rounded_rectangle(
        [px(9.8), px(10.5), px(9.8 + 5), px(10.5 + 19)],
        radius=sz(2.5),
        fill=WHITE,
    )
    # 3) 右柱 x=33.2 y=18.5 w=5 h=19 rx=2.5
    d.rounded_rectangle(
        [px(33.2), px(18.5), px(33.2 + 5), px(18.5 + 19)],
        radius=sz(2.5),
        fill=WHITE,
    )
    # 4) 中央紫点 x=20.9 y=19.5 w=9 h=9 rx=2.6
    d.rounded_rectangle(
        [px(20.9), px(19.5), px(20.9 + 9), px(19.5 + 9)],
        radius=sz(2.6),
        fill=PURPLE,
    )
    # 5) 连接线 (16.4,26)->(18.6,24.7) stroke 3.4 round cap，opacity 0.55
    line_col = (0x7C, 0x6C, 0xF0, int(255 * 0.55))
    lw = max(1, int(round(sz(3.4))))
    p1 = (px(16.4), px(26.0))
    p2 = (px(18.6), px(24.7))
    d.line([p1, p2], fill=line_col, width=lw)
    r = sz(3.4) / 2.0
    for (cx, cy) in (p1, p2):
        d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=line_col)

    return img


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    out_dir = os.path.abspath(OUT_DIR)

    written = []
    # 主产物：留白版（商店提交用）
    master = draw_mark(SS_BASE, fullbleed=False)
    for size in SIZES:
        step = master.resize((size * SS, size * SS), Image.LANCZOS)
        final = step.resize((size, size), Image.LANCZOS)
        path = os.path.join(out_dir, f"ic_launcher_{size}x{size}.png")
        final.save(path, "PNG")
        written.append(path)
        print(f"  wrote {os.path.basename(path)}")

    # 备选产物：满幅版
    fb_dir = os.path.join(out_dir, "满幅备选")
    os.makedirs(fb_dir, exist_ok=True)
    fb_master = draw_mark(SS_BASE, fullbleed=True)
    for size in SIZES:
        step = fb_master.resize((size * SS, size * SS), Image.LANCZOS)
        final = step.resize((size, size), Image.LANCZOS)
        path = os.path.join(fb_dir, f"ic_launcher_fullbleed_{size}x{size}.png")
        final.save(path, "PNG")
        written.append(path)
        print(f"  wrote 满幅备选/{os.path.basename(path)}")

    # 母版留档，便于后续调整
    master_path = os.path.join(out_dir, "_master_4096.png")
    master.save(master_path, "PNG")
    written.append(master_path)
    print(f"  wrote {os.path.basename(master_path)}")

    print(f"\n输出目录: {out_dir}")
    return written


if __name__ == "__main__":
    main()
