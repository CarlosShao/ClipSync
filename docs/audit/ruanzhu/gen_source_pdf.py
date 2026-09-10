import re
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, PageBreak, Spacer
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont

pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))

files = [
    r'd:\work\java\AI-workspace\ClipSync\docs\audit\ruanzhu\源代码_前30页.txt',
    r'd:\work\java\AI-workspace\ClipSync\docs\audit\ruanzhu\源代码_后30页.txt',
]
out = r'd:\work\java\AI-workspace\ClipSync\docs\audit\ruanzhu\源代码_前30页与后30页.pdf'

header_pat = re.compile(r'^ClipSync 剪贴板同步软件  V1\.0\.0  第 (\d+) 页$')

def parse_pages(path):
    with open(path, 'r', encoding='utf-8') as f:
        lines = f.read().splitlines()
    pages = []
    current = None
    for line in lines:
        m = header_pat.match(line)
        if m:
            if current:
                pages.append(current)
            current = {'page': int(m.group(1)), 'lines': []}
        else:
            if current is None:
                # stray lines before first header, ignore
                continue
            current['lines'].append(line)
    if current:
        pages.append(current)
    return pages

pages = []
for f in files:
    pages.extend(parse_pages(f))

header_style = ParagraphStyle('h', fontName='STSong-Light', fontSize=10, leading=16, alignment=1, spaceAfter=6)
code_style = ParagraphStyle('c', fontName='STSong-Light', fontSize=7.5, leading=11.5, leftIndent=0, spaceAfter=0)

doc = SimpleDocTemplate(out, pagesize=A4,
                        leftMargin=18*mm, rightMargin=18*mm,
                        topMargin=18*mm, bottomMargin=18*mm)
story = []
for idx, p in enumerate(pages):
    story.append(Paragraph(f'ClipSync 剪贴板同步软件  V1.0.0  第 {p["page"]} 页', header_style))
    # ensure exactly 50 source lines; pad if needed
    lines = p['lines'][:50]
    while len(lines) < 50:
        lines.append('')
    for ln in lines:
        # escape xml special chars for reportlab Paragraph
        txt = ln.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')
        story.append(Paragraph(txt, code_style))
    if idx != len(pages) - 1:
        story.append(PageBreak())

doc.build(story)
print('OK', out, 'pages', len(pages))
