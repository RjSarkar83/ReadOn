#!/usr/bin/env python3
"""assets/make_icons.py — one source of truth for every icon ArtViSiON ships.

    python3 assets/make_icons.py        (needs Pillow)

The mark is the original artwork in `assets/artvision-logo.png` — the file the brand owner
delivered, untouched. Every icon, favicon and the social card is derived from it, so the logo
can never drift between the header, the browser tab and the home screen.
"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'assets', 'artvision-logo.png')
PAPER = (248, 244, 239, 255)          # --bg of the ArtViSiON light theme


def core():
    im = Image.open(SRC).convert('RGBA')
    return im.crop(im.getbbox())      # trim the transparent margin


def square(mark, size, scale, bg=PAPER):
    out = Image.new('RGBA', (size, size), bg)
    w = int(size * scale)
    h = int(w * mark.height / mark.width)
    out.alpha_composite(mark.resize((w, h), Image.LANCZOS), ((size - w) // 2, (size - h) // 2))
    return out


def main():
    mark = core()
    jobs = [
        ('icon-192.png', 192, 0.86), ('icon-512.png', 512, 0.86),
        ('icon-512-maskable.png', 512, 0.68),
        ('apple-touch-icon.png', 180, 0.86),
        ('favicon-32.png', 32, 0.94), ('favicon-16.png', 16, 0.96),
    ]
    for rel, size, scale in jobs:
        square(mark, size, scale).convert('RGB').save(os.path.join(ROOT, rel), optimize=True)
        print('wrote', rel)

    mark.save(os.path.join(ROOT, 'screenshots', 'logo.png'), optimize=True)

    card = Image.new('RGB', (1200, 630), PAPER)
    d = ImageDraw.Draw(card)
    for i in range(630):                                   # a barely-there vertical wash
        t = i / 630
        d.line([(0, i), (1200, i)], fill=(int(250 - 8 * t), int(244 - 6 * t), int(236 - 4 * t)))
    w = 620
    h = int(w * mark.height / mark.width)
    card.paste(mark.resize((w, h), Image.LANCZOS), ((1200 - w) // 2, 90))
    card.save(os.path.join(ROOT, 'screenshots', 'og-card.png'), optimize=True)
    print('wrote screenshots/og-card.png')


if __name__ == '__main__':
    main()
