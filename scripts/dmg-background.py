"""Draws the DMG window's background (660×400, plus @2x): graphite, an arrow from E.V to Applications."""
import sys
from PIL import Image, ImageDraw, ImageFilter, ImageFont

def draw(scale: int, path: str) -> None:
    w, h = 660 * scale, 400 * scale
    img = Image.new("RGB", (w, h), (11, 13, 16))
    glow = Image.new("RGB", (w, h), (0, 0, 0))
    g = ImageDraw.Draw(glow)
    g.ellipse([w * 0.2, -h * 0.5, w * 0.8, h * 0.45], fill=(22, 64, 52))
    img = Image.blend(img, glow.filter(ImageFilter.GaussianBlur(90 * scale)), 0.55)
    d = ImageDraw.Draw(img)
    mint = (62, 230, 176)
    y = 190 * scale
    x0, x1 = 252 * scale, 408 * scale
    for i in range(0, x1 - x0 - 26 * scale, 14 * scale):
        d.rounded_rectangle([x0 + i, y - 2 * scale, x0 + i + 7 * scale, y + 2 * scale], radius=2 * scale, fill=mint)
    d.polygon([(x1, y), (x1 - 18 * scale, y - 11 * scale), (x1 - 18 * scale, y + 11 * scale)], fill=mint)
    try:
        font = ImageFont.truetype("/System/Library/Fonts/SFNS.ttf", 15 * scale)
    except OSError:
        font = ImageFont.load_default()
    text = "Drag E.V into Applications"
    tw = d.textlength(text, font=font)
    d.text(((w - tw) / 2, 318 * scale), text, fill=(180, 188, 200), font=font)
    img.save(path, dpi=(72 * scale, 72 * scale))

out = sys.argv[1]
draw(1, f"{out}/background.png")
draw(2, f"{out}/background@2x.png")
