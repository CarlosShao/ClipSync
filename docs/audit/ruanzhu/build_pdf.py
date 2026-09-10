#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
将 docs/audit/ruanzhu/操作说明书.md + screenshots/*.png 生成为 PDF。
用法：
    python docs/audit/ruanzhu/build_pdf.py
输出：
    docs/audit/ruanzhu/操作说明书.pdf
"""

import os
import re
import sys
from pathlib import Path

from reportlab.lib import colors, pagesizes
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import cm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.platypus import (
    Image,
    Paragraph,
    Preformatted,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)
from reportlab.lib.utils import ImageReader

BASE_DIR = Path(__file__).resolve().parent
MD_PATH = BASE_DIR / "操作说明书.md"
IMG_DIR = BASE_DIR / "screenshots"
OUTPUT_PDF = BASE_DIR / "操作说明书.pdf"

pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))


def _escape(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace('"', "&quot;")
    )


def _strip_inline(text: str) -> str:
    # 去掉加粗/斜体标记；保留内容
    text = re.sub(r"\*\*(.+?)\*\*", r"\1", text)
    text = re.sub(r"\*(.+?)\*", r"\1", text)
    # 行内代码去掉反引号
    text = re.sub(r"`(.+?)`", r"\1", text)
    # 一些 reportlab CID 字体里没有的符号
    text = text.replace("⌘", "Cmd")
    return text


def _para(text: str, style: ParagraphStyle) -> Paragraph:
    return Paragraph(_escape(_strip_inline(text)), style)


def _make_styles():
    styles = {}
    styles["h1"] = ParagraphStyle(
        "H1",
        fontName="STSong-Light",
        fontSize=20,
        leading=28,
        alignment=TA_LEFT,
        spaceAfter=16,
        textColor=colors.HexColor("#111827"),
    )
    styles["h2"] = ParagraphStyle(
        "H2",
        fontName="STSong-Light",
        fontSize=16,
        leading=24,
        alignment=TA_LEFT,
        spaceAfter=12,
        spaceBefore=12,
        textColor=colors.HexColor("#1f2937"),
    )
    styles["h3"] = ParagraphStyle(
        "H3",
        fontName="STSong-Light",
        fontSize=13,
        leading=20,
        alignment=TA_LEFT,
        spaceAfter=8,
        spaceBefore=8,
        textColor=colors.HexColor("#374151"),
    )
    styles["body"] = ParagraphStyle(
        "Body",
        fontName="STSong-Light",
        fontSize=11,
        leading=18,
        alignment=TA_LEFT,
        spaceAfter=6,
        firstLineIndent=0,
    )
    styles["quote"] = ParagraphStyle(
        "Quote",
        fontName="STSong-Light",
        fontSize=10,
        leading=16,
        alignment=TA_LEFT,
        leftIndent=16,
        textColor=colors.HexColor("#4b5563"),
        spaceAfter=8,
    )
    styles["code"] = ParagraphStyle(
        "Code",
        fontName="Courier",
        fontSize=9,
        leading=13,
        alignment=TA_LEFT,
        leftIndent=8,
        textColor=colors.HexColor("#1f2937"),
    )
    styles["table"] = ParagraphStyle(
        "Table",
        fontName="STSong-Light",
        fontSize=9,
        leading=14,
        alignment=TA_LEFT,
    )
    styles["caption"] = ParagraphStyle(
        "Caption",
        fontName="STSong-Light",
        fontSize=10,
        leading=15,
        alignment=TA_CENTER,
        textColor=colors.HexColor("#4b5563"),
        spaceAfter=10,
    )
    return styles


def _is_table_separator(row: list[str]) -> bool:
    return all(re.fullmatch(r":?-+", cell.replace(" ", "")) for cell in row)


def parse_markdown(md_text: str, styles: dict, img_dir: Path):
    lines = md_text.splitlines()
    flowables = []
    i = 0
    n = len(lines)

    while i < n:
        raw_line = lines[i]
        line = raw_line.rstrip("\n")

        # 空行
        if line.strip() == "":
            i += 1
            continue

        # 分隔线
        if line.strip() == "---":
            i += 1
            continue

        # 标题
        m = re.match(r"^(#{1,6})\s+(.*)", line)
        if m:
            level = len(m.group(1))
            text = m.group(2)
            style_key = f"h{min(level, 3)}"
            flowables.append(_para(text, styles[style_key]))
            i += 1
            continue

        # 代码块
        if line.strip().startswith("```"):
            lang = line.strip()[3:].strip()
            code_lines = []
            i += 1
            while i < n and not lines[i].strip().startswith("```"):
                code_lines.append(lines[i].rstrip("\n"))
                i += 1
            i += 1  # 跳过结束 ```
            if code_lines:
                code_text = "\n".join(code_lines)
                flowables.append(Spacer(1, 0.2 * cm))
                flowables.append(
                    Preformatted(
                        code_text,
                        styles["code"],
                        maxLineLength=120,
                        splitChars=" ",
                    )
                )
                flowables.append(Spacer(1, 0.2 * cm))
            continue

        # 表格
        if line.strip().startswith("|"):
            table_rows = []
            while i < n and lines[i].strip().startswith("|"):
                row_text = lines[i].strip()
                # 去掉首尾 |
                if row_text.startswith("|"):
                    row_text = row_text[1:]
                if row_text.endswith("|"):
                    row_text = row_text[:-1]
                cells = [c.strip() for c in row_text.split("|")]
                table_rows.append(cells)
                i += 1

            data = []
            header_idx = 0
            for idx, row in enumerate(table_rows):
                if _is_table_separator(row):
                    continue
                data.append([_para(cell, styles["table"]) for cell in row])
                if idx == 0:
                    header_idx = len(data) - 1

            if data:
                table = Table(data, hAlign="LEFT")
                tbl_style = TableStyle(
                    [
                        ("FONTNAME", (0, 0), (-1, -1), "STSong-Light"),
                        ("FONTSIZE", (0, 0), (-1, -1), 9),
                        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                        ("GRID", (0, 0), (-1, -1), 0.5, colors.grey),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                        ("TOPPADDING", (0, 0), (-1, -1), 4),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                        (
                            "BACKGROUND",
                            (0, header_idx),
                            (-1, header_idx),
                            colors.HexColor("#f3f4f6"),
                        ),
                    ]
                )
                table.setStyle(tbl_style)
                flowables.append(Spacer(1, 0.2 * cm))
                flowables.append(table)
                flowables.append(Spacer(1, 0.2 * cm))
            continue

        # 图片占位
        m = re.match(r"^\[图\s+(\d+)(?:[：:](.*))?\]$", line.strip())
        if m:
            fig_no = int(m.group(1))
            fig_label = (m.group(2) or "").strip()
            img_path = img_dir / f"screenshot_{fig_no:02d}.png"
            if img_path.exists():
                ir = ImageReader(str(img_path))
                img_w, img_h = ir.getSize()
                max_w = 16 * cm
                scale = min(max_w / img_w, 10 * cm / img_h)
                disp_w = img_w * scale
                disp_h = img_h * scale
                flowables.append(Spacer(1, 0.3 * cm))
                flowables.append(Image(str(img_path), width=disp_w, height=disp_h))
                caption = f"图 {fig_no}"
                if fig_label:
                    caption += f"：{fig_label}"
                flowables.append(_para(caption, styles["caption"]))
                flowables.append(Spacer(1, 0.2 * cm))
            else:
                flowables.append(_para(f"[图 {fig_no} 截图待补充]", styles["body"]))
            i += 1
            continue

        # 引用块
        if line.startswith(">"):
            quote_parts = []
            while i < n and lines[i].startswith(">"):
                quote_parts.append(lines[i][1:].strip())
                i += 1
            quote_text = " ".join(quote_parts)
            flowables.append(_para(quote_text, styles["quote"]))
            continue

        # 列表
        bullet_match = re.match(r"^-\s+(.*)", line)
        number_match = re.match(r"^(\d+)\.\s+(.*)", line)
        if bullet_match:
            items = []
            while i < n:
                m = re.match(r"^-\s+(.*)", lines[i])
                if not m:
                    break
                items.append(m.group(1))
                i += 1
            for item in items:
                flowables.append(
                    _para(f"• {_strip_inline(item)}", styles["body"])
                )
            continue
        if number_match:
            items = []
            while i < n:
                m = re.match(r"^(\d+)\.\s+(.*)", lines[i])
                if not m:
                    break
                items.append(m.group(2))
                i += 1
            for idx, item in enumerate(items, start=1):
                flowables.append(
                    _para(f"{idx}. {_strip_inline(item)}", styles["body"])
                )
            continue

        # 普通段落（可能跨多行）
        para_lines = [line.strip()]
        i += 1
        while i < n and lines[i].strip() != "":
            # 遇到标题、表格、代码、引用、列表、图片占位则结束
            l = lines[i]
            if (
                re.match(r"^#{1,6}\s+", l)
                or l.strip().startswith("```")
                or l.strip().startswith("|")
                or l.strip() == "---"
                or l.startswith(">")
                or re.match(r"^\[图\s+\d", l.strip())
                or re.match(r"^-\s+", l)
                or re.match(r"^\d+\.\s+", l)
            ):
                break
            para_lines.append(l.strip())
            i += 1
        para_text = " ".join(para_lines)
        flowables.append(_para(para_text, styles["body"]))

    return flowables


def main():
    if not MD_PATH.exists():
        print(f"错误：找不到 {MD_PATH}")
        sys.exit(1)

    md_text = MD_PATH.read_text(encoding="utf-8")
    styles = _make_styles()
    flowables = parse_markdown(md_text, styles, IMG_DIR)

    doc = SimpleDocTemplate(
        str(OUTPUT_PDF),
        pagesize=pagesizes.A4,
        rightMargin=2 * cm,
        leftMargin=2 * cm,
        topMargin=2 * cm,
        bottomMargin=2 * cm,
    )
    doc.build(flowables)
    print(f"已生成：{OUTPUT_PDF}")


if __name__ == "__main__":
    main()
