"""DSH 任务完成弹窗 —— 卡片渲染。

把一条通知渲染成 RGBA 位图。配色不写死：优先用 DSH 客户端上报的
`--dsw-*` token 实测值，拿不到时回落到 DSH 深色设计 token 的默认值。
这样弹窗会跟随当前主题（含第三方主题对 token 的覆盖）。

渲染用 PIL 完成：文字抗锯齿、圆角遮罩、渐变底色都是一次成像，
再由 popup.py 交给 Win32 分层窗口显示。
"""

from __future__ import annotations

import base64
import io
import os
import re

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

# ── 字体 ──────────────────────────────────────────────────────────────────
_FONTS = {
    "bold": [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\segoeuib.ttf"],
    "regular": [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\segoeui.ttf"],
}
_font_cache: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def _font(weight: str, size: int) -> ImageFont.FreeTypeFont:
    key = (weight, size)
    hit = _font_cache.get(key)
    if hit is not None:
        return hit
    for path in _FONTS.get(weight, _FONTS["regular"]):
        if os.path.exists(path):
            try:
                font = ImageFont.truetype(path, size)
                _font_cache[key] = font
                return font
            except OSError:
                continue
    fallback = ImageFont.load_default()
    _font_cache[key] = fallback
    return fallback


# ── 默认配色（DSH 深色设计 token 原值） ──────────────────────────────────
DEFAULTS = {
    "surface": (35, 35, 36),       # alias-bg-layer-1 #232324
    "surface_top": (44, 44, 46),   # alias-bg-layer-2 #2c2c2e
    "title": (249, 250, 251),      # alias-label-primary
    "body": (207, 211, 214),       # alias-label-secondary
    "meta": (173, 178, 184),       # alias-label-tertiary
    "accent": (122, 170, 255),     # deepseek-400
    "hairline": (255, 255, 255),
    "hairline_alpha": 31,
}

STATUS_COLORS = {
    "done": (34, 197, 94),        # alias-state-success-primary
    "failed": (236, 19, 19),      # alias-state-error-primary
    "cancelled": (245, 158, 11),  # alias-state-warn-primary
    "running": (122, 170, 255),
}


def _rgb(value, fallback):
    """把 `#rgb` / `#rrggbb` / `rgb(...)` 解析成三元组。"""
    if not isinstance(value, str):
        return fallback
    text = value.strip()
    m = re.fullmatch(r"#([0-9a-fA-F]{3})", text)
    if m:
        return tuple(int(c * 2, 16) for c in m.group(1))
    m = re.fullmatch(r"#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?", text)
    if m:
        h = m.group(1)
        return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    m = re.fullmatch(r"rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:\s*[,/]\s*[\d.]+%?)?\s*\)", text)
    if m:
        return (int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return fallback


def _alpha_of(value, fallback: int) -> int:
    if not isinstance(value, str):
        return fallback
    text = value.strip()
    m = re.fullmatch(r"#(?:[0-9a-fA-F]{6})([0-9a-fA-F]{2})", text)
    if m:
        return int(m.group(1), 16)
    m = re.fullmatch(r"rgba\([^)]*?,\s*([0-9.]+)\s*\)", text)
    if m:
        try:
            return max(0, min(255, int(float(m.group(1)) * 255)))
        except ValueError:
            return fallback
    return fallback


def palette_from_tokens(tokens, dark=True) -> dict:
    """把客户端上报的 DSH token 映射成卡片配色。"""
    out = dict(DEFAULTS if dark else LIGHT_DEFAULTS)
    if not isinstance(tokens, dict):
        return out
    mapping = {
        "--dsw-alias-bg-layer-1": "surface",
        "--dsw-alias-bg-layer-2": "surface_top",
        "--dsw-alias-label-primary": "title",
        "--dsw-alias-label-secondary": "body",
        "--dsw-alias-label-tertiary": "meta",
        "--dsw-alias-state-business-primary": "accent",
        "--dsw-alias-border-l3": "hairline",
    }
    for token, key in mapping.items():
        if token in tokens:
            out[key] = _rgb(tokens[token], out[key])
    if "--dsw-alias-border-l3" in tokens:
        out["hairline_alpha"] = _alpha_of(tokens["--dsw-alias-border-l3"], out["hairline_alpha"])
    return out


# ── 几何 ──────────────────────────────────────────────────────────────────
CARD_W = 444
RADIUS = 14
PAD_X = 18
PAD_Y = 14
ART_H = 116
ART_GAP = 12
ACCENT_BAR = 3

LIGHT_DEFAULTS = {
    "surface": (255, 255, 255),
    "surface_top": (255, 255, 255),
    "title": (15, 17, 21),
    "body": (97, 102, 107),
    "meta": (129, 133, 140),
    "accent": (65, 118, 230),
    "hairline": (0, 0, 0),
    "hairline_alpha": 26,
}


def _rounded_mask(w: int, h: int, radius: int, ss: int = 4) -> Image.Image:
    big = Image.new("L", (w * ss, h * ss), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, w * ss - 1, h * ss - 1), radius=radius * ss, fill=255)
    return big.resize((w, h), Image.LANCZOS)


def _gradient(w: int, h: int, top, bottom) -> Image.Image:
    t = np.array(top, dtype=np.float32)
    b = np.array(bottom, dtype=np.float32)
    ramp = np.linspace(0.0, 1.0, h, dtype=np.float32)[:, None, None]
    rows = t[None, None, :] * (1.0 - ramp) + b[None, None, :] * ramp
    return Image.fromarray(np.repeat(rows, w, axis=1).astype("uint8"), "RGB")


def _load_art(spec: dict):
    raw = None
    if spec.get("art_base64"):
        try:
            raw = base64.b64decode(spec["art_base64"])
        except (ValueError, TypeError):
            raw = None
    elif spec.get("art_path"):
        try:
            with open(spec["art_path"], "rb") as handle:
                raw = handle.read()
        except OSError:
            raw = None
    if raw is None:
        return None
    try:
        return Image.open(io.BytesIO(raw)).convert("RGBA")
    except OSError:
        return None


def _fit(image: Image.Image, box_w: int, box_h: int) -> Image.Image:
    ratio = min(box_w / image.width, box_h / image.height)
    return image.resize(
        (max(1, int(image.width * ratio)), max(1, int(image.height * ratio))), Image.LANCZOS)


def _clip(draw: ImageDraw.ImageDraw, text: str, font, max_w: int) -> str:
    if not text:
        return ""
    if draw.textlength(text, font=font) <= max_w:
        return text
    ell = "…"
    budget = max_w - draw.textlength(ell, font=font)
    if budget <= 0:
        return ell
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if draw.textlength(text[:mid], font=font) <= budget:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo].rstrip() + ell


def _wrap(draw: ImageDraw.ImageDraw, text: str, font, max_w: int, max_lines: int = 2):
    """按像素宽度折行（中日韩逐字折）。"""
    if not text:
        return []
    lines = []
    current = ""
    for char in text:
        candidate = current + char
        if draw.textlength(candidate, font=font) <= max_w:
            current = candidate
            continue
        if current:
            lines.append(current)
        if len(lines) >= max_lines:
            current = ""
            break
        current = char
    if current and len(lines) < max_lines:
        lines.append(current)
    if lines:
        lines[-1] = _clip(draw, lines[-1], font, max_w)
    return lines


def render(spec: dict) -> Image.Image:
    """渲染一张通知卡。spec 见 popup.py 的指令说明。"""
    dark = bool(spec.get("dark", True))
    tokens = spec.get("tokens")
    palette = palette_from_tokens(tokens, dark)
    theme_id = spec.get("theme_id", "")
    accents = spec.get("theme_accents")
    if isinstance(accents, list) and accents:
        palette["accent"] = _rgb(accents[0], palette["accent"])
        for key, value in (("surface_top", accents[min(1, len(accents)-1)]), ("surface", accents[-1])):
            tint = _rgb(value, palette[key])
            palette[key] = tuple(int(base * .86 + color * .14) for base, color in zip(palette[key], tint))
    elif theme_id and isinstance(tokens, dict):
        palette["accent"] = _rgb(tokens.get("--dsw-alias-brand-primary"), palette["accent"])

    status = str(spec.get("status") or "done").lower()
    accent = palette["accent"]
    if status == "failed":
        accent = STATUS_COLORS["failed"]
    elif status == "cancelled":
        accent = STATUS_COLORS["cancelled"]

    title = str(spec.get("title") or "任务完成")
    body = str(spec.get("body") or "")
    meta = str(spec.get("meta") or "")
    brand = str(spec.get("brand") or "DeepSeek Harness")

    art = _load_art(spec)
    width = CARD_W
    f_brand = _font("bold", 11)
    f_title = _font("bold", 15)
    f_body = _font("regular", 12)
    f_meta = _font("regular", 10)

    text_w = width - PAD_X * 2 - ((ART_H + ART_GAP) if art is not None else 0)

    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    wrapped = _wrap(probe, body, f_body, text_w, max_lines=2)
    # 品牌行 + 标题 + 正文行 + meta
    height = PAD_Y * 2 + 19 + 21 + len(wrapped) * 16 + (15 if meta else 0)
    height = max(height, 144 if art is not None else 96)

    card = _gradient(width, height, palette["surface_top"], palette["surface"]).convert("RGBA")

    # 强调色柔光，呼应主题的发光质感
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).ellipse(
        (-width * 0.30, -height * 1.1, width * 0.45, height * 0.75), fill=(*accent, 40))
    card.alpha_composite(glow.filter(ImageFilter.GaussianBlur(46)))

    draw = ImageDraw.Draw(card)

    # 左侧强调色条 + 发丝描边
    draw.rounded_rectangle((0, 0, ACCENT_BAR, height), radius=1, fill=(*accent, 255))
    if isinstance(accents, list) and len(accents) >= 2:
        # The theme's signature gradient stays in a thin ribbon, away from text.
        start, end = _rgb(accents[0], accent), _rgb(accents[-1], accent)
        for x in range(12, width - 12):
            mix = (x - 12) / max(1, width - 24)
            color = tuple(int(a * (1 - mix) + b * mix) for a, b in zip(start, end))
            draw.line((x, height - 5, x, height - 3), fill=(*color, 220))
    draw.rounded_rectangle((0, 0, width - 1, height - 1), radius=RADIUS,
                           outline=(*palette["hairline"], palette["hairline_alpha"]), width=1)

    if art is not None:
        fitted = _fit(art, ART_H, height - PAD_Y * 2)
        card.alpha_composite(fitted, (width - PAD_X - fitted.width, (height - fitted.height) // 2))

    y = PAD_Y
    dot = 3
    draw.ellipse((PAD_X, y + 5, PAD_X + dot * 2, y + 5 + dot * 2), fill=(*accent, 255))
    draw.text((PAD_X + dot * 2 + 6, y), _clip(draw, brand, f_brand, text_w),
              font=f_brand, fill=(*palette["meta"], 255))
    y += 19

    draw.text((PAD_X, y), _clip(draw, title, f_title, text_w), font=f_title,
              fill=(*palette["title"], 255))
    y += 21

    for line in wrapped:
        draw.text((PAD_X, y), line, font=f_body, fill=(*palette["body"], 255))
        y += 16

    if meta:
        draw.text((PAD_X, y), _clip(draw, meta, f_meta, text_w), font=f_meta,
                  fill=(*palette["meta"], 255))

    mask = _rounded_mask(width, height, RADIUS)
    alpha = np.minimum(np.asarray(card.getchannel("A")), np.asarray(mask))
    card.putalpha(Image.fromarray(alpha.astype("uint8"), "L"))
    return card


def to_premultiplied_bgra(image: Image.Image) -> bytes:
    """RGBA → UpdateLayeredWindow 需要的预乘 BGRA。"""
    arr = np.asarray(image.convert("RGBA"), dtype=np.uint16)
    r, g, b, a = arr[..., 0], arr[..., 1], arr[..., 2], arr[..., 3]
    out = np.empty((image.height, image.width, 4), dtype="uint8")
    out[..., 0] = (b * a // 255).astype("uint8")
    out[..., 1] = (g * a // 255).astype("uint8")
    out[..., 2] = (r * a // 255).astype("uint8")
    out[..., 3] = a.astype("uint8")
    return out.tobytes()
