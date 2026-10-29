#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
dsh-session-cost — 素材处理：生图模型给的 PNG → 透明底小立绘 → assets/art.json。

为什么要这一步（而不是直接把 PNG 塞进插件）：

  1. 生图模型这次给的是**白底**（虽然要求了透明），白底贴纸放进深浅两套主题里
     都会顶着一块白方块。所以这里把「接近纯白且和边缘连通」的像素抠成透明。
  2. 面板里只显示 44px，原图 1024×1024 / 758KB 没必要；缩到 256 再存 WebP
     （带 alpha）能把内联进 client.js 的体积压到几十 KB。
  3. 顺带按不透明像素裁掉四周留白，让立绘在框里占满，不用靠 CSS 猜 padding。

抠图算法刻意保守：**只从四角做泛洪**（flood fill），只吃「和角落同色且接近纯白」
的连通区域。这样鲸鱼肚子里、硬币里的白色高光不会被误伤 —— 那些白色和边缘不连通。

用法：
    python tools/prepare-art.py            # 用默认源图
    python tools/prepare-art.py <源图>      # 换一张源图
"""

import base64
import json
import os
import sys

from PIL import Image

# Windows 控制台默认可能是 GBK，中文进度信息会变乱码。
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:  # pragma: no cover - 老解释器或重定向场景
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ASSETS = os.path.join(ROOT, "assets")
ART_DIR = os.path.join(ASSETS, "art")
OUT_JSON = os.path.join(ASSETS, "art.json")

#: 生图模型的输出目录（会话工作目录下的 dsh-images）。
DEFAULT_SOURCE = os.path.join("D:\\SAVE\\AI-Work\\Dsh-Work", "dsh-images", "dsh-session-cost-mascot.png")

#: 输出边长（2 倍档：面板里显示 44px）。
TARGET = 256

#: 判定「接近纯白」的阈值：三个通道都 >= 该值才算背景候选。
WHITE_MIN = 244

#: 抠完之后 alpha 小于该值的像素直接抹成完全透明，减少 WebP 里的半透明噪声。
ALPHA_FLOOR = 8


def load_source(path):
    if not os.path.isfile(path):
        raise SystemExit("源图不存在：%s" % path)
    return Image.open(path).convert("RGBA")


def background_mask(image):
    """从四角泛洪，返回「背景」像素集合（用一维 bool 列表表示）。"""
    width, height = image.size
    pixels = image.load()
    mask = bytearray(width * height)
    stack = []

    def is_white(x, y):
        r, g, b, a = pixels[x, y]
        return a > 0 and r >= WHITE_MIN and g >= WHITE_MIN and b >= WHITE_MIN

    for corner in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if is_white(*corner):
            stack.append(corner)

    while stack:
        x, y = stack.pop()
        index = y * width + x
        if mask[index]:
            continue
        if not is_white(x, y):
            continue
        mask[index] = 1
        if x > 0:
            stack.append((x - 1, y))
        if x + 1 < width:
            stack.append((x + 1, y))
        if y > 0:
            stack.append((x, y - 1))
        if y + 1 < height:
            stack.append((x, y + 1))
    return mask


def key_out_background(image):
    """把背景抠成透明，并顺手把「贴着背景的边缘半白像素」也压掉一点，减少白边。"""
    width, height = image.size
    pixels = image.load()
    mask = background_mask(image)
    removed = 0
    for y in range(height):
        row = y * width
        for x in range(width):
            index = row + x
            if mask[index]:
                r, g, b, _ = pixels[x, y]
                pixels[x, y] = (r, g, b, 0)
                removed += 1
                continue
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            # 邻接背景的浅色描边像素：按它有多接近白色削一部分 alpha，收掉白边。
            near = False
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < width and 0 <= ny < height and mask[ny * width + nx]:
                    near = True
                    break
            if near:
                whiteness = min(r, g, b)
                if whiteness >= 200:
                    drop = int((whiteness - 200) / 55 * 255)
                    pixels[x, y] = (r, g, b, max(0, a - drop))
    return removed


def trim(image):
    """按不透明像素裁掉四周留白。"""
    bbox = image.getbbox()
    if bbox is None:
        return image
    return image.crop(bbox)


def square(image, size, margin_ratio=0.04):
    """等比缩放到边长 size 的正方形画布，居中，留一点边距。"""
    inner = int(round(size * (1 - margin_ratio * 2)))
    width, height = image.size
    scale = inner / max(width, height)
    resized = image.resize((max(1, int(round(width * scale))), max(1, int(round(height * scale)))), Image.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(resized, ((size - resized.width) // 2, (size - resized.height) // 2), resized)
    return canvas


def main():
    source = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SOURCE
    image = load_source(source)
    original = image.size
    removed = key_out_background(image)
    image = trim(image)
    image = square(image, TARGET)

    # alpha 太低的像素直接抹平，省得 WebP 里留一堆半透明噪声
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            r, g, b, a = pixels[x, y]
            if a < ALPHA_FLOOR:
                pixels[x, y] = (r, g, b, 0)

    os.makedirs(ART_DIR, exist_ok=True)
    webp_path = os.path.join(ART_DIR, "mascot.webp")
    image.save(webp_path, "WEBP", quality=86, method=6)

    with open(webp_path, "rb") as handle:
        encoded = base64.b64encode(handle.read()).decode("ascii")

    payload = {
        "mascot": "data:image/webp;base64," + encoded,
        "_source": os.path.basename(source),
        "_sourceSize": [original[0], original[1]],
        "_output": "art/mascot.webp",
        "_outputSize": [image.width, image.height],
        "_keyedPixels": removed,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=1)

    print("源图 %s %dx%d" % (os.path.basename(source), original[0], original[1]))
    if removed == 0:
        print("源图本来就是透明底（没有可抠的白底像素）")
    print("抠掉背景像素 %d，裁切后 %dx%d，输出 %s（%.1f KB），base64 %.1f KB" % (
        removed, image.width, image.height, os.path.relpath(webp_path, ROOT),
        os.path.getsize(webp_path) / 1024, len(encoded) / 1024))


if __name__ == "__main__":
    main()
