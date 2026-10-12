"""Rebuild the login assistant's vivid glass key icon (Pillow required)."""

from pathlib import Path

from PIL import Image, ImageDraw


destination = Path(__file__).resolve().parents[1] / "extension" / "icons"
destination.mkdir(parents=True, exist_ok=True)
scale = 4
size = 128 * scale

# Diagonal sky -> blue, matching --grad-accent in popup.css.
stops = [(0.0, (56, 189, 248)), (1.0, (59, 130, 246))]
small = Image.new("RGB", (128, 128))
pixels = small.load()
for y in range(128):
    for x in range(128):
        t = (x + y) / 254
        for index in range(len(stops) - 1):
            start, end = stops[index], stops[index + 1]
            if start[0] <= t <= end[0]:
                span = end[0] - start[0]
                k = 0.0 if span == 0 else (t - start[0]) / span
                pixels[x, y] = tuple(round(start[1][c] + (end[1][c] - start[1][c]) * k) for c in range(3))
                break
        else:
            pixels[x, y] = stops[-1][1]

gradient = small.resize((size, size), Image.Resampling.BILINEAR).convert("RGBA")
canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))

mask = Image.new("L", (size, size), 0)
ImageDraw.Draw(mask).rounded_rectangle((2 * scale, 2 * scale, 126 * scale, 126 * scale), radius=29 * scale, fill=255)
canvas.paste(gradient, (0, 0), mask)

# Top gloss, then the glass key strokes.
gloss = Image.new("RGBA", (size, size), (0, 0, 0, 0))
ImageDraw.Draw(gloss).rounded_rectangle((2 * scale, 2 * scale, 126 * scale, 74 * scale), radius=29 * scale, fill=(255, 255, 255, 58))
canvas = Image.alpha_composite(canvas, Image.composite(gloss, Image.new("RGBA", (size, size), (0, 0, 0, 0)), mask))

draw = ImageDraw.Draw(canvas)
draw.ellipse((25 * scale, 24 * scale, 70 * scale, 69 * scale), outline="#FFFFFF", width=8 * scale)
draw.line([(63 * scale, 62 * scale), (101 * scale, 100 * scale)], fill="#FFFFFF", width=8 * scale)
draw.line([(81 * scale, 80 * scale), (91 * scale, 70 * scale)], fill="#FFFFFF", width=8 * scale)
draw.line([(94 * scale, 93 * scale), (104 * scale, 83 * scale)], fill="#FFFFFF", width=8 * scale)
draw.rounded_rectangle((2 * scale, 2 * scale, 126 * scale, 126 * scale), radius=29 * scale, outline=(255, 255, 255, 130), width=2 * scale)

for icon_size in (16, 32, 48, 128):
    canvas.resize((icon_size, icon_size), Image.Resampling.LANCZOS).save(destination / f"icon{icon_size}.png")
print("Created extension icons: 16, 32, 48, 128 px.")
