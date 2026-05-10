"""
Run once to generate icons/icon{16,48,128}.png
Requires: pip install pillow
"""
import os
from pathlib import Path

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Run: pip install pillow")
    raise

os.makedirs("icons", exist_ok=True)

def make_icon(size: int):
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Pink circle background
    pad = size // 8
    draw.ellipse([pad, pad, size - pad, size - pad], fill="#ff3f6c")

    # White "S" letter centred
    font_size = int(size * 0.5)
    try:
        font = ImageFont.truetype("arialbd.ttf", font_size)
    except Exception:
        font = ImageFont.load_default()

    text = "S"
    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), text, fill="white", font=font)

    path = Path("icons") / f"icon{size}.png"
    img.save(path)
    print(f"  Created {path}")

for sz in (16, 48, 128):
    make_icon(sz)

print("Done! Icons saved to icons/")
