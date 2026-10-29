"""离线预览：把挂件的「立绘 + 气泡文字」按实际比例合成出来，验证气泡框对不对得上。

用法：python tools/preview.py
产出：preview/<id>-light.png / <id>-dark.png
"""
from __future__ import annotations

import json
import os

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ART_JSON = os.path.join(ROOT, "assets", "art.json")
OUT_DIR = os.path.join(ROOT, "preview")

# 与 lib/client.js 里的 t() 文案、配色保持一致
# (ink, inkSoft, fill) —— 气泡内容按页取 PAGES 里的 (大号, 小号)
LABELS = {
    "grok": ("#6E1F2C", "#9A5A5F", (255, 240, 238, 210)),
    "claude": ("#A8451A", "#C97A4E", (255, 243, 231, 210)),
    "gemini": ("#3B34A0", "#6E68C4", (240, 240, 255, 210)),
    "glm": ("#141821", "#4E5766", (248, 250, 253, 210)),
    "gpt": ("#2A2444", "#6B6590", (246, 245, 255, 210)),
}

# 气泡是一块两页的牌子：用量页与余额页。两张都要出图，否则文档会和实现不符。
PAGES = {
    "": ("12.7k", "tokens · 上下文 20%"),
    "-balance": ("¥5.77", "余额"),
}
WIDTH = 264  # 与 CSS 里的 --tw-w 一致
BACKGROUNDS = {"light": (247, 245, 252, 255), "dark": (19, 17, 39, 255)}


def load_font(size: int) -> ImageFont.FreeTypeFont:
    for candidate in (r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"):
        if os.path.exists(candidate):
            try:
                return ImageFont.truetype(candidate, size)
            except OSError:
                continue
    return ImageFont.load_default()


def main() -> int:
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(ART_JSON, encoding="utf-8") as fh:
        art = json.load(fh)

    import base64
    import io

    for cid, entry in art.items():
        raw = base64.b64decode(entry["url"].split(",", 1)[1])
        with Image.open(io.BytesIO(raw)) as image:
            scaled = image.convert("RGBA")
            height = round(scaled.height * WIDTH / scaled.width)
            scaled = scaled.resize((WIDTH, height), Image.LANCZOS)

        bubble = entry["bubble"]
        box = (
            round(WIDTH * bubble["left"] / 100),
            round(height * bubble["top"] / 100),
            round(WIDTH * (bubble["left"] + bubble["width"]) / 100),
            round(height * (bubble["top"] + bubble["height"]) / 100),
        )

        ink, ink_soft, fill = LABELS.get(cid, LABELS["grok"])
        for page_suffix, (big, small) in PAGES.items():
            for name, background in BACKGROUNDS.items():
                canvas = Image.new("RGBA", (WIDTH, height), background)
                canvas.alpha_composite(scaled)
                overlay = Image.new("RGBA", (WIDTH, height), (0, 0, 0, 0))
                draw = ImageDraw.Draw(overlay)
                draw.ellipse(box, fill=fill)
                canvas.alpha_composite(overlay)

                draw = ImageDraw.Draw(canvas)
                big_font = load_font(max(11, round(WIDTH * 0.045 * 1.25)))
                small_font = load_font(max(9, round(WIDTH * 0.045 * 0.78)))
                center_x = (box[0] + box[2]) // 2
                # 两行整体居中：大号偏上、小号偏下（与 .tw-bubble 的 flex 居中一致）。
                center_y = (box[1] + box[3]) // 2
                draw.text((center_x, center_y - big_font.size * 0.6), big, font=big_font, fill=ink, anchor="mm")
                draw.text((center_x, center_y + big_font.size * 0.45), small, font=small_font, fill=ink_soft, anchor="mm")

                # 翻页小圆点：气泡底部两个点，当前页那个更亮。
                dot_r = max(2, round(WIDTH * 0.007))
                dot_y = box[3] - dot_r * 3
                gap = dot_r * 3
                for index, on in enumerate((page_suffix == "", page_suffix != "")):
                    dot_x = center_x + (index * 2 - 1) * gap // 2
                    dot_fill = ink_soft if on else None
                    if dot_fill is None:
                        # 未选中的点用淡一点的同色，Pillow 没有 alpha 混合的快捷方式，直接调浅。
                        dot_fill = tuple(min(255, c + 110) for c in ink_soft) if isinstance(ink_soft, tuple) else ink_soft
                    draw.ellipse(
                        (dot_x - dot_r, dot_y - dot_r, dot_x + dot_r, dot_y + dot_r),
                        fill=dot_fill,
                    )

                out = os.path.join(OUT_DIR, f"{cid}{page_suffix}-{name}.png")
                canvas.convert("RGB").save(out)
                print(f"[ok] {out}  气泡框={box}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
