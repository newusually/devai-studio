"""
生成 DevAI Studio 应用图标（多尺寸 ICO + PNG）
用法: python scripts/make_icon.py
输出: build/icon.ico (Windows 安装包/托盘), build/icon.png (256px), resources/icon.ico
"""
import struct, zlib, os, math

OUT_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'build')
RES_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'resources')
os.makedirs(OUT_DIR, exist_ok=True)
os.makedirs(RES_DIR, exist_ok=True)


def lerp(a, b, t):
    return a + (b - a) * t


def draw_icon(size):
    """画一个圆角方形渐变底 + 字母 D 的位图 (RGBA bytes)"""
    px = bytearray(size * size * 4)
    cx = cy = size / 2.0
    radius = size * 0.20          # 圆角半径
    # 渐变：#4d8dff → #7b5cff（左上到右下）
    c1 = (77, 141, 255)
    c2 = (123, 92, 255)

    for y in range(size):
        for x in range(size):
            i = (y * size + x) * 4
            # 圆角矩形判定
            dx = max(radius - x, 0, x - (size - radius))
            dy = max(radius - y, 0, y - (size - radius))
            d = math.hypot(dx, dy)
            if d > radius:
                continue  # 透明
            # 抗锯齿边缘
            alpha = 255
            if d > radius - 1.2:
                alpha = int(255 * max(0.0, (radius - d) / 1.2))
                if alpha <= 0:
                    continue

            t = (x + y) / (2.0 * size)
            r = int(lerp(c1[0], c2[0], t))
            g = int(lerp(c1[1], c2[1], t))
            b = int(lerp(c1[2], c2[2], t))

            # 画字母 D：一条竖线 + 一个半圆
            lx, ly = x + 0.5, y + 0.5
            s = size
            stroke = s * 0.115          # 线宽
            left = s * 0.315            # 竖线 x
            top = s * 0.275             # 上边 y
            bottom = s * 0.725          # 下边 y
            outer_r = (bottom - top) / 2.0
            mid_y = (top + bottom) / 2.0

            ink = False
            # 竖线
            if abs(lx - left) < stroke / 2 and top - stroke * 0.4 <= ly <= bottom + stroke * 0.4:
                ink = True
            # 右侧半圆环（圆心在 left + outer_r*0.62，半径 outer_r）
            ccx = left + outer_r * 0.62
            if ccx < lx:                 # 只画右半边
                dd = math.hypot(lx - ccx, ly - mid_y)
                if abs(dd - outer_r * 0.66) < stroke / 2:
                    ink = True

            if ink:
                px[i] = 255
                px[i + 1] = 255
                px[i + 2] = 255
                px[i + 3] = alpha
            else:
                px[i] = r
                px[i + 1] = g
                px[i + 2] = b
                px[i + 3] = alpha

    return bytes(px)


def png_bytes(size):
    raw = bytearray()
    data = draw_icon(size)
    for y in range(size):
        raw.append(0)  # filter type 0
        raw += data[y * size * 4:(y + 1) * size * 4]

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    return out


def build_ico(sizes=(16, 24, 32, 48, 64, 128, 256)):
    """把多个 PNG 尺寸打包成 ICO"""
    images = [(s, png_bytes(s)) for s in sizes]
    offset = 6 + 16 * len(images)
    entries = b''
    datas = b''
    for s, png in images:
        entries += struct.pack('<BBBBHHII', s if s < 256 else 0, s if s < 256 else 0,
                                0, 0, 1, 32, len(png), offset)
        datas += png
        offset += len(png)
    header = struct.pack('<HHH', 0, 1, len(images))
    return header + entries + datas


if __name__ == '__main__':
    ico = build_ico()
    ico_path = os.path.join(OUT_DIR, 'icon.ico')
    with open(ico_path, 'wb') as f:
        f.write(ico)
    print(f'icon.ico   -> {ico_path} ({len(ico)} bytes)')

    png = png_bytes(256)
    png_path = os.path.join(OUT_DIR, 'icon.png')
    with open(png_path, 'wb') as f:
        f.write(png)
    print(f'icon.png   -> {png_path} ({len(png)} bytes)')

    # resources 目录放一份（开发模式窗口图标用）
    res_ico = os.path.join(RES_DIR, 'icon.ico')
    with open(res_ico, 'wb') as f:
        f.write(ico)
    print(f'resources  -> {res_ico}')
