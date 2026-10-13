"""Generate high-fidelity extension icons and logo from the master illustration (Pillow required)."""

from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MASTER_PATH = ROOT / "tools" / "logo_master.png"

TARGET_DIRS = [
    ROOT / "extension" / "icons",
    ROOT / "release" / "extension" / "icons",
]

for d in TARGET_DIRS:
    d.mkdir(parents=True, exist_ok=True)

raw = Image.open(MASTER_PATH).convert("RGBA")

# Center content crop: bounding box center is ~ (635, 593), crop 1220x1220
cx, cy = 635, 593
size = 1220
x0 = max(0, cx - size // 2)
y0 = max(0, cy - size // 2)
master_cropped = raw.crop((x0, y0, x0 + size, y0 + size))

def render_icon(target_size: int, radius_ratio: float = 0.22) -> Image.Image:
    """Render an icon with 4x supersampled rounded corners and subtle border."""
    scale = 4
    canvas_size = target_size * scale
    radius = int(canvas_size * radius_ratio)

    resized_master = master_cropped.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)

    # 4x supersampled rounded rectangle mask
    mask = Image.new("L", (canvas_size, canvas_size), 0)
    draw_mask = ImageDraw.Draw(mask)
    draw_mask.rounded_rectangle((0, 0, canvas_size - 1, canvas_size - 1), radius=radius, fill=255)

    composite = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
    composite.paste(resized_master, (0, 0), mask)

    # Subtle boundary outline for high contrast on light/dark backgrounds
    draw_border = ImageDraw.Draw(composite)
    outline_color = (203, 213, 225, 175)
    border_width = max(1 * scale, int(1.5 * scale))
    draw_border.rounded_rectangle(
        (0, 0, canvas_size - 1, canvas_size - 1),
        radius=radius,
        outline=outline_color,
        width=border_width,
    )

    # Downscale with Lanczos filtering for pristine anti-aliasing
    return composite.resize((target_size, target_size), Image.Resampling.LANCZOS)

ICON_SIZES = (16, 32, 48, 128)

for size in ICON_SIZES:
    icon = render_icon(size)
    filename = f"icon{size}.png"
    for dest in TARGET_DIRS:
        icon.save(dest / filename)
    print(f"Generated {filename} ({size}x{size})")

print("All icons successfully generated and synced to extension and release directories.")
