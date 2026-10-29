"""把 DSH 会话挂件的立绘素材处理成可内联的透明 WebP。

输入（用户素材目录）：
    <SRC_DIR>/20261004-040915.png           -> grok    金发哥特萝莉（黑金 / 酒红）
    <SRC_DIR>/meme_claude_deepseek.png      -> claude  橙发少女（暖橙）
    <SRC_DIR>/meme_deepseek1_hua_notext.png -> gemini  Gemini猫猫（蓝紫 / 星屑）
    <GLM>/GLM-1.png                         -> glm     GLM（黑白狐耳 / 冰蓝宝石）

三张素材本身就带 alpha（背景透明、气泡内也透明），所以处理是：
    1. 直接沿用源 alpha；若素材是不透明的白底图（换成别的素材时可能遇到），
       才退回去做「从四角泛洪去白底」；
    2. 蒙版收 1px，去掉缩放后出现的白边 / 黑边；
    3. 裁到内容边界、缩到展示宽度；
    4. 在 alpha 里找「被内容围住的透明空洞」，最大的一块就是气泡内部，
       换成百分比写进 art.json —— 挂件靠它把 token 数字打进气泡正中。

产物：
    assets/art/<id>.webp
    assets/art.json   -> { id: { url, bubble: {left,top,width,height} } }
"""
from __future__ import annotations

import base64
import io
import json
import os
import sys
from collections import deque

from PIL import Image, ImageDraw, ImageFilter

SRC_DIR = r"D:\SAVE\WORK\AI-work\AI\Token"
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART_DIR = os.path.join(ROOT, "assets", "art")
ART_JSON = os.path.join(ROOT, "assets", "art.json")

TARGET_WIDTH = 760
MAGENTA = (255, 0, 255)

CHARACTERS = [
    ("grok", "20261004-040915.png"),
    ("claude", "meme_claude_deepseek.png"),
    ("gemini", "meme_deepseek1_hua_notext.png"),
    ("gpt", r"D:\SAVE\WORK\AI-work\AI\dsh主题\GPT\GPT-sticker.png"),
    # 绝对路径 = 素材不在 SRC_DIR 里，直接用这一张
    # （早期把这个角色写成了 ZLM，是笔误；素材目录与文件名已一并改成 GLM）
    ("glm", r"D:\SAVE\WORK\AI-work\AI\dsh主题\GLM\GLM-1.png"),
]

# 找不到空洞时的兜底文字框（按经验值，宁可偏小也不要压到线稿上）
FALLBACK_BUBBLE = {"left": 7.0, "top": 8.0, "width": 42.0, "height": 24.0}


def has_transparency(image: Image.Image, sample: int = 40000) -> bool:
    """粗采样判断素材是否已经带 alpha（避免在 1M 像素上做全量统计）。"""
    alpha = image.convert("RGBA").getchannel("A")
    step = max(1, (alpha.width * alpha.height) // sample)
    flat = alpha.getdata()
    return any(flat[i] < 250 for i in range(0, len(flat), step))


def cut_white_background(image: Image.Image) -> Image.Image:
    """不透明白底素材的兜底：从四角泛洪，只吃掉与边缘连通的白色。"""
    rgb = image.convert("RGB")
    width, height = rgb.size
    for point in ((0, 0), (width - 1, 0), (0, height - 1), (width - 1, height - 1)):
        if rgb.getpixel(point) != MAGENTA:
            ImageDraw.floodfill(rgb, point, MAGENTA, thresh=40)
    alpha = Image.new("L", rgb.size, 255)
    source = rgb.load()
    target = alpha.load()
    for y in range(height):
        for x in range(width):
            if source[x, y] == MAGENTA:
                target[x, y] = 0
    out = image.convert("RGBA")
    out.putalpha(alpha)
    return out


def find_bubble(image: Image.Image) -> dict[str, float] | None:
    """最大的「被内容围住的透明空洞」= 气泡内部。"""
    width, height = image.size
    alpha = image.getchannel("A").load()
    hole = bytearray(width * height)
    for y in range(height):
        row = y * width
        for x in range(width):
            if alpha[x, y] < 128:
                hole[row + x] = 1

    # 与画布边缘连通的透明 = 外部背景，排除掉
    seen = bytearray(width * height)
    queue: deque[tuple[int, int]] = deque()
    for x in range(width):
        queue.append((x, 0))
        queue.append((x, height - 1))
    for y in range(height):
        queue.append((0, y))
        queue.append((width - 1, y))
    while queue:
        x, y = queue.popleft()
        index = y * width + x
        if seen[index] or not hole[index]:
            continue
        seen[index] = 1
        hole[index] = 0
        if x > 0:
            queue.append((x - 1, y))
        if x + 1 < width:
            queue.append((x + 1, y))
        if y > 0:
            queue.append((x, y - 1))
        if y + 1 < height:
            queue.append((x, y + 1))

    min_area = max(64, int(width * height * 0.02))
    marker = bytearray(width * height)
    best: tuple[int, tuple[int, int, int, int]] | None = None
    for y in range(height):
        for x in range(width):
            index = y * width + x
            if not hole[index] or marker[index]:
                continue
            queue = deque([(x, y)])
            marker[index] = 1
            area = 0
            left, top, right, bottom = x, y, x, y
            while queue:
                cx, cy = queue.popleft()
                area += 1
                left = min(left, cx)
                right = max(right, cx)
                top = min(top, cy)
                bottom = max(bottom, cy)
                for nx, ny in ((cx - 1, cy), (cx + 1, cy), (cx, cy - 1), (cx, cy + 1)):
                    if 0 <= nx < width and 0 <= ny < height:
                        nindex = ny * width + nx
                        if hole[nindex] and not marker[nindex]:
                            marker[nindex] = 1
                            queue.append((nx, ny))
            if area >= min_area and (best is None or area > best[0]):
                best = (area, (left, top, right, bottom))

    if best is None:
        return None
    left, top, right, bottom = best[1]
    # 内缩一点，别把文字贴到线稿上
    inset_x = (right - left + 1) * 0.10
    inset_y = (bottom - top + 1) * 0.16
    left += inset_x
    right -= inset_x
    top += inset_y
    bottom -= inset_y
    return {
        "left": round(left / width * 100, 2),
        "top": round(top / height * 100, 2),
        "width": round((right - left + 1) / width * 100, 2),
        "height": round((bottom - top + 1) / height * 100, 2),
    }


def trim(image: Image.Image, pad: int = 6) -> Image.Image:
    box = image.getchannel("A").getbbox()
    if box is None:
        return image
    left, top, right, bottom = box
    return image.crop(
        (
            max(0, left - pad),
            max(0, top - pad),
            min(image.width, right + pad),
            min(image.height, bottom + pad),
        )
    )


def main() -> int:
    os.makedirs(ART_DIR, exist_ok=True)
    table: dict[str, dict[str, object]] = {}
    for cid, filename in CHARACTERS:
        src = filename if os.path.isabs(filename) else os.path.join(SRC_DIR, filename)
        if not os.path.exists(src):
            print(f"[skip] 素材不存在: {src}", file=sys.stderr)
            continue
        with Image.open(src) as raw:
            rgba = raw.convert("RGBA")
            if has_transparency(rgba):
                source = "源 alpha"
            else:
                rgba = cut_white_background(rgba)
                source = "去白底"

        rgba.putalpha(rgba.getchannel("A").filter(ImageFilter.MinFilter(3)))
        cut = trim(rgba)
        if cut.width > TARGET_WIDTH:
            ratio = TARGET_WIDTH / cut.width
            cut = cut.resize((TARGET_WIDTH, max(1, round(cut.height * ratio))), Image.LANCZOS)

        bubble = find_bubble(cut) or dict(FALLBACK_BUBBLE)

        out_path = os.path.join(ART_DIR, f"{cid}.webp")
        cut.save(out_path, "WEBP", quality=88, method=6)
        buf = io.BytesIO()
        cut.save(buf, "WEBP", quality=88, method=6)
        url = "data:image/webp;base64," + base64.b64encode(buf.getvalue()).decode("ascii")
        table[cid] = {"url": url, "bubble": bubble}

        transparent = cut.getchannel("A").histogram()[0]
        total = cut.width * cut.height
        print(
            f"[ok] {cid:9s} {cut.width}x{cut.height}  {source}  "
            f"透明 {transparent * 100 // total}%  "
            f"webp {len(buf.getvalue()) // 1024}KB  dataURL {len(url) // 1024}KB  "
            f"气泡 L{bubble['left']} T{bubble['top']} W{bubble['width']} H{bubble['height']}"
        )

    with open(ART_JSON, "w", encoding="utf-8") as fh:
        json.dump(table, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"[done] 写出 {ART_JSON}（{len(table)} 个立绘）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
