"""Generate SafeShe launcher icons (shield + heart) for each mipmap density."""
import os, sys
from PIL import Image, ImageDraw

out = sys.argv[1]
sizes = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
for dens, px in sizes.items():
    S = 512
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.ellipse((8, 8, S - 8, S - 8), fill=(15, 157, 88, 255))
    # shield
    d.polygon([(256, 90), (400, 145), (390, 290), (256, 430), (122, 290), (112, 145)], fill=(255, 255, 255, 255))
    # heart
    d.ellipse((186, 190, 262, 266), fill=(15, 157, 88, 255))
    d.ellipse((250, 190, 326, 266), fill=(15, 157, 88, 255))
    d.polygon([(192, 244), (320, 244), (256, 340)], fill=(15, 157, 88, 255))
    folder = os.path.join(out, f"mipmap-{dens}")
    os.makedirs(folder, exist_ok=True)
    im.resize((px, px), Image.LANCZOS).save(os.path.join(folder, "ic_launcher.png"))
print("icons ok")
