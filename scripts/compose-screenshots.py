
import json, os
from PIL import Image

SHOTS = r'D:\WorkSpace\projects\Wxminiprogram\oil_trend\docs\screenshots'

PAIRS = [
    ('canvas-home-mini.png', '01-price-home.png', '01-price-home-final.png'),
    ('canvas-trend.png',     '02-trend.png',     '02-trend-final.png'),
    ('canvas-global.png',    '04-global.png',    '04-global-final.png'),
]

for canvas_name, page_name, out_name in PAIRS:
    canvas_path = os.path.join(SHOTS, canvas_name)
    rect_path = os.path.join(SHOTS, canvas_name.replace('.png', '.rect.json'))
    page_path = os.path.join(SHOTS, page_name)
    if not (os.path.exists(canvas_path) and os.path.exists(rect_path) and os.path.exists(page_path)):
        print('SKIP', canvas_name); continue
    rect = json.load(open(rect_path, 'r', encoding='utf-8'))
    w = int(rect['width']); h = int(rect['height'])
    left = int(rect['left']); top = int(rect['top'])
    page = Image.open(page_path).convert('RGBA')
    canvas = Image.open(canvas_path).convert('RGBA').resize((w, h), Image.LANCZOS)
    page.alpha_composite(canvas, (left, top))
    out = os.path.join(SHOTS, out_name)
    page.convert('RGB').save(out, 'PNG', optimize=True)
    print('COMPOSITED', out_name, page.size, 'canvas at', (left, top, w, h))
