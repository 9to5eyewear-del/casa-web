#!/usr/bin/env python3
"""Generate responsive AVIF/WebP/JPEG variants for the site.

Usage:
  python3 scripts/optimize-images.py <slug>=<source path> [<slug>=<source path> ...]

Example:
  python3 scripts/optimize-images.py garden-01="new photos/IMG_1234.jpg"

Writes img/<slug>-<width>.{avif,webp,jpg} for widths 640/1280/1920
(capped at the source width, never upscaled) and prints a GALLERY row to paste into index.html.
"""
import sys
from pathlib import Path
from PIL import Image, ImageOps

WIDTHS = (640, 1280, 1920)
OUT = Path(__file__).resolve().parent.parent / "img"


def process(slug, src):
    im = ImageOps.exif_transpose(Image.open(src)).convert("RGB")
    OUT.mkdir(exist_ok=True)
    for w in WIDTHS:
        r = im if im.width <= w else im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
        r.save(OUT / f"{slug}-{w}.avif", quality=55, speed=6)
        r.save(OUT / f"{slug}-{w}.webp", quality=78, method=6)
        r.save(OUT / f"{slug}-{w}.jpg", quality=80, optimize=True, progressive=True)
    print(f"  {{ slug: '{slug}', cat: '', w: {im.width}, h: {im.height}, alt: '' }},")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    for arg in sys.argv[1:]:
        slug, src = arg.split("=", 1)
        process(slug, src)
