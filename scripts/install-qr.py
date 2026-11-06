#!/usr/bin/env python3
"""Regenerate the fixed install URL QR (version 3, byte mode, ECC L, mask 0).
No runtime library or external QR service is required. Four-module quiet zone.
"""
from pathlib import Path

URL = 'https://idol-chat.onrender.com/shell/install.html'
payload = URL.encode('ascii')
assert len(payload) <= 53
bits = '0100' + f'{len(payload):08b}' + ''.join(f'{b:08b}' for b in payload)
bits += '0' * min(4, 440 - len(bits))
bits += '0' * (-len(bits) % 8)
data = [int(bits[i:i+8], 2) for i in range(0, len(bits), 8)]
while len(data) < 55:
    data.append((0xec, 0x11)[(len(data) - (len(bits) // 8)) % 2])

def mul(x, y):
    result = 0
    for i in range(7, -1, -1):
        result = (result << 1) ^ ((result >> 7) * 0x11d)
        result ^= ((y >> i) & 1) * x
    return result

# Reed-Solomon divisor and remainder, one block of 55 data + 15 ECC bytes.
divisor = [0] * 14 + [1]
root = 1
for _ in range(15):
    for j in range(15):
        divisor[j] = mul(divisor[j], root)
        if j < 14:
            divisor[j] ^= divisor[j+1]
    root = mul(root, 2)
ecc = [0] * 15
for b in data:
    factor = b ^ ecc.pop(0)
    ecc.append(0)
    ecc = [x ^ mul(y, factor) for x, y in zip(ecc, divisor)]
stream = ''.join(f'{b:08b}' for b in data + ecc)
n = 29
matrix = [[False] * n for _ in range(n)]
reserved = [[False] * n for _ in range(n)]
def put(x, y, value):
    matrix[y][x] = bool(value)
    reserved[y][x] = True
for i in range(n):
    put(6, i, i % 2 == 0)
    put(i, 6, i % 2 == 0)
for cx, cy in [(3, 3), (25, 3), (3, 25)]:
    for dy in range(-4, 5):
        for dx in range(-4, 5):
            x, y = cx + dx, cy + dy
            if 0 <= x < n and 0 <= y < n:
                put(x, y, max(abs(dx), abs(dy)) not in (2, 4))
for dy in range(-2, 3):
    for dx in range(-2, 3):
        put(22+dx, 22+dy, max(abs(dx), abs(dy)) != 1)
# BCH-encoded ECC L / mask 0 format word.
fmt = 0x77c4
for i in range(6): put(8, i, (fmt >> i) & 1)
put(8, 7, (fmt >> 6) & 1)
put(8, 8, (fmt >> 7) & 1)
put(7, 8, (fmt >> 8) & 1)
for i in range(9, 15): put(14-i, 8, (fmt >> i) & 1)
for i in range(8): put(n-1-i, 8, (fmt >> i) & 1)
for i in range(8, 15): put(8, n-15+i, (fmt >> i) & 1)
put(8, n-8, True)
index = 0
right = n - 1
while right >= 1:
    if right == 6: right = 5
    for vertical in range(n):
        y = n-1-vertical if ((right+1) & 2) == 0 else vertical
        for x in [right, right-1]:
            if not reserved[y][x]:
                value = index < len(stream) and stream[index] == '1'
                matrix[y][x] = value ^ ((x+y) % 2 == 0)
                index += 1
    right -= 2
assert index == 567
rects = ''.join(f'<path d="M{x+4} {y+4}h1v1h-1z"/>' for y in range(n) for x in range(n) if matrix[y][x])
svg = f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 37 37" shape-rendering="crispEdges"><title>扫描打开 Daily Him 安装页</title><path fill="#fff" d="M0 0h37v37H0z"/><g fill="#111">{rects}</g></svg>\n'
Path(__file__).resolve().parents[1].joinpath('public/shell/install-qr.svg').write_text(svg)
