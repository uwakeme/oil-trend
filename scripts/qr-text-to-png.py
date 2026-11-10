"""
把开发者工具 CLI 输出的终端字符二维码渲染成可扫码的 PNG。

CLI 的 --qr-output 写的是带 ANSI 颜色码的文本（\x1b[47m  \x1b[0m 白、\x1b[40m  \x1b[0m 黑），
不是图片。这里把它解析成模块矩阵再画成 PNG。

用法：python scripts/qr-text-to-png.py <输入文本> <输出 png>
"""
import re
import sys
from PIL import Image

ANSI_MODULE = re.compile(r'\x1b\[(40|47)m  \x1b\[0m')


def parse_modules(text):
    rows = []
    for line in text.split('\n'):
        mods = ANSI_MODULE.findall(line)
        if mods:
            rows.append([1 if m == '40' else 0 for m in mods])
    if not rows:
        raise SystemExit('没有解析出二维码模块，文件格式不对')

    width = max(len(r) for r in rows)
    # 补齐宽度
    for r in rows:
        while len(r) < width:
            r.append(0)

    # 裁掉四周全白边
    def all_white_col(c):
        return all(r[c] == 0 for r in rows)

    def all_white_row(r):
        return all(v == 0 for v in rows[r])

    left = 0
    while left < width and all_white_col(left):
        left += 1
    right = width - 1
    while right >= left and all_white_col(right):
        right -= 1
    top = 0
    while top < len(rows) and all_white_row(top):
        top += 1
    bottom = len(rows) - 1
    while bottom >= top and all_white_row(bottom):
        bottom -= 1

    matrix = [r[left:right + 1] for r in rows[top:bottom + 1]]
    return matrix


def render(matrix, out_path, scale=10, quiet=4):
    n = len(matrix)
    size = (n + quiet * 2) * scale
    img = Image.new('RGB', (size, size), 'white')
    px = img.load()
    for y in range(n):
        for x in range(n):
            if matrix[y][x]:
                for dy in range(scale):
                    for dx in range(scale):
                        px[(x + quiet) * scale + dx, (y + quiet) * scale + dy] = (0, 0, 0)
    img.save(out_path, 'PNG')
    return size


def main():
    if len(sys.argv) < 3:
        raise SystemExit('用法: python scripts/qr-text-to-png.py <输入文本> <输出 png>')
    matrix = parse_modules(open(sys.argv[1], 'r', encoding='utf-8', errors='replace').read())
    size = render(matrix, sys.argv[2])
    print('二维码 %dx%d 模块 → PNG %s (%dx%d px)' % (len(matrix), len(matrix), sys.argv[2], size, size))


if __name__ == '__main__':
    main()
