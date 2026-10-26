"""
生成 DevAI Studio 全部图标资源（集中到 build/ 与 resources/）
用法: python scripts/make_icon.py

产出（全部相对路径，electron-builder 会打进 exe）：
  build/icon.ico            Windows 安装包 / exe 图标（多尺寸 16→256）
  build/icon.png            256px 透明 PNG
  build/tray.png            32px 托盘图标
  resources/icon.ico        运行时窗口图标（开发模式）
  resources/icon.png        运行时窗口图标 PNG
  build/installer.ico       安装程序图标（同一份，避免重复）
"""
import struct, zlib, os, math

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
RES = os.path.join(ROOT, 'resources')
os.makedirs(BUILD, exist_ok=True)
os.makedirs(RES, exist_ok=True)


def draw_icon(size, style='gradient'):
    """画圆角方形渐变底 + 字母 D（带像素级抗锯齿）"""
    px = bytearray(size * size * 4)
    s = size
    cx = cy = s / 2.0
    radius = s * 0.20

    c1 = (77, 141, 255)     # #4d8dff
    c2 = (123, 92, 255)     # #7b5cff
    if style == 'flat':
        c1 = c2 = (58, 110, 220)

    # 字母 D 的几何参数
    left = s * 0.315
    top = s * 0.275
    bottom = s * 0.725
    stroke = s * 0.115
    outer_r = (bottom - top) / 2.0
    mid_y = (top + bottom) / 2.0
    ccx = left + outer_r * 0.62

    def in_alpha(x, y):
        """返回像素的 (是否在圆角内, 是否在字母上, 覆盖率)"""
        # 圆角矩形：距四个圆角圆心的最小距离
        dx = 0.0
        if x < radius:
            dx = max(dx, radius - x)
        elif x > s - radius:
            dx = max(dx, x - (s - radius))
        dy = 0.0
        if y < radius:
            dy = max(dy, radius - y)
        elif y > s - radius:
            dy = max(dy, y - (s - radius))
        d = math.hypot(dx, dy)
        cov_bg = max(0.0, min(1.0, radius - d + 0.5))

        # 字母 D 覆盖率
        cov_fg = 0.0
        # 竖线
        if abs(x - left) < stroke / 2 + 0.5 and top - stroke * 0.4 <= y <= bottom + stroke * 0.4:
            cov_fg = 1.0
        # 半圆环（只画右半边）
        if x >= ccx:
            dd = math.hypot(x - ccx, y - mid_y)
            target = outer_r * 0.66
            if abs(dd - target) < stroke / 2 + 0.5:
                cov_fg = 1.0
        return cov_bg, cov_fg

    for y in range(s):
        for x in range(s):
            i = (y * s + x) * 4
            cov_bg, cov_fg = in_alpha(x + 0.5, y + 0.5)
            if cov_bg <= 0:
                continue
            t = (x + y) / (2.0 * s)
            r = int(c1[0] + (c2[0] - c1[0]) * t)
            g = int(c1[1] + (c2[1] - c1[1]) * t)
            b = int(c1[2] + (c2[2] - c1[2]) * t)
            # 前景白色覆盖
            if cov_fg > 0:
                a = cov_fg
                r = int(r * (1 - a) + 255 * a)
                g = int(g * (1 - a) + 255 * a)
                b = int(b * (1 - a) + 255 * a)
            px[i] = r
            px[i + 1] = g
            px[i + 2] = b
            px[i + 3] = int(255 * cov_bg)

    return bytes(px)


def png_bytes(size, style='gradient'):
    raw = bytearray()
    data = draw_icon(size, style)
    for y in range(size):
        raw.append(0)
        raw += data[y * size * 4:(y + 1) * size * 4]

    def chunk(tag, payload):
        return (struct.pack('>I', len(payload)) + tag + payload
                + struct.pack('>I', zlib.crc32(tag + payload) & 0xffffffff))

    out = b'\x89PNG\r\n\x1a\n'
    out += chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
    out += chunk(b'IDAT', zlib.compress(bytes(raw), 9))
    out += chunk(b'IEND', b'')
    return out


def build_ico(sizes=(16, 24, 32, 48, 64, 128, 256), style='gradient'):
    images = [(s, png_bytes(s, style)) for s in sizes]
    offset = 6 + 16 * len(images)
    entries = b''
    datas = b''
    for s, png in images:
        entries += struct.pack('<BBBBHHII', s if s < 256 else 0, s if s < 256 else 0,
                               0, 0, 1, 32, len(png), offset)
        datas += png
        offset += len(png)
    return struct.pack('<HHH', 0, 1, len(images)) + entries + datas


if __name__ == '__main__':
    ico = build_ico()
    for path in (os.path.join(BUILD, 'icon.ico'),
                 os.path.join(BUILD, 'installer.ico'),
                 os.path.join(RES, 'icon.ico')):
        with open(path, 'wb') as f:
            f.write(ico)
        print(f'  {os.path.relpath(path, ROOT)}  ({len(ico)} bytes)')

    p256 = os.path.join(BUILD, 'icon.png')
    with open(p256, 'wb') as f:
        f.write(png_bytes(256))
    print(f'  {os.path.relpath(p256, ROOT)}  (256px)')

    tray = os.path.join(BUILD, 'tray.png')
    with open(tray, 'wb') as f:
        f.write(png_bytes(32))
    print(f'  {os.path.relpath(tray, ROOT)}  (32px 托盘)')

    rp = os.path.join(RES, 'icon.png')
    with open(rp, 'wb') as f:
        f.write(png_bytes(256))
    print(f'  {os.path.relpath(rp, ROOT)}  (运行时窗口图标)')

    print('\n✓ 全部图标已生成（集中在 build/ 与 resources/，随 exe 打包）')
