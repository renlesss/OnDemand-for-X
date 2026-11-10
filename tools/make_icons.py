"""Draws the extension icons: a short feed that ends, and the button that asks for the next batch.

    python3 tools/make_icons.py icons [store/assets]   (needs Pillow; the PNGs are committed, nobody needs to re-run this)
"""
import sys
from PIL import Image, ImageDraw

SIZES = [16, 32, 48, 128]
BG = (53, 88, 230, 255)        # indigo blue, deliberately not the blue of X
FG = (255, 255, 255, 255)
SOFT = (255, 255, 255, 190)


def draw(size):
    s = size * 16                              # supersample, then downscale for clean edges
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((0, 0, s - 1, s - 1), radius=int(s * 0.22), fill=BG)

    small = size <= 32
    left = int(s * 0.20)
    bars = (
        # (top, right edge, colour); fewer and thicker bars on the tiny icons
        [(0.16, 0.80, FG), (0.36, 0.60, SOFT)] if size <= 16 else
        [(0.17, 0.80, FG), (0.31, 0.60, SOFT), (0.45, 0.72, SOFT)]
    )
    bar_h = int(s * (0.13 if size <= 16 else 0.10 if small else 0.085))
    for top, right, col in bars:
        t = int(s * top)
        d.rounded_rectangle((left, t, int(s * right), t + bar_h), radius=bar_h // 2, fill=col)

    # the button: a white pill with a small downward chevron
    pill_top = int(s * (0.62 if size <= 16 else 0.64))
    pill_h = int(s * (0.24 if size <= 16 else 0.20))
    d.rounded_rectangle((int(s * 0.20), pill_top, int(s * 0.80), pill_top + pill_h), radius=pill_h // 2, fill=FG)
    cx, cy = s // 2, pill_top + pill_h // 2
    w, h = int(s * 0.085), int(s * 0.045)
    lw = max(int(s * (0.05 if size <= 16 else 0.035)), 2)
    d.line([(cx - w, cy - h), (cx, cy + h), (cx + w, cy - h)], fill=BG, width=lw, joint="curve")
    r = lw // 2
    for x, y in ((cx - w, cy - h), (cx + w, cy - h)):
        d.ellipse((x - r, y - r, x + r, y + r), fill=BG)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    out = sys.argv[1]
    for n in SIZES:
        draw(n).save(f"{out}/icon{n}.png", optimize=True)
    print("icons written to", out)
    if len(sys.argv) > 2:                      # the 300x300 logo the Edge Add-ons listing asks for
        draw(300).save(f"{sys.argv[2]}/logo-300.png", optimize=True)
        print("store logo written to", sys.argv[2])
