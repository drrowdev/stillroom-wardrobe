"""Generate synthetic image inputs for check-browser.mjs; no personal photos.
Usage: python3 generate-image-fixtures.py /absolute/temporary/output
Requires Pillow as a validation-only dependency.
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageOps
import io
import json
import random
import sys

out = Path(sys.argv[1]).resolve()
out.mkdir(parents=True, exist_ok=True)
base = Image.new("RGB", (2000, 1500))
draw = ImageDraw.Draw(base)
colours = [(225, 35, 35), (30, 180, 45), (30, 65, 225), (235, 210, 30)]
for box, colour in zip([(0, 0, 999, 749), (1000, 0, 1999, 749),
                        (0, 750, 999, 1499), (1000, 750, 1999, 1499)], colours):
    draw.rectangle(box, fill=colour)
fixtures = []

def corners(im):
    w, h = im.size
    return [list(im.getpixel((int(x*w), int(y*h))))[:3]
            for x, y in [(0.1, 0.1), (0.9, 0.1), (0.1, 0.9), (0.9, 0.9)]]

for orientation in range(1, 9):
    exif = Image.Exif()
    exif[274] = orientation
    exif[315] = "Synthetic metadata removal fixture"
    exif[34853] = {1: "N", 2: (60.0, 10.0, 0.0), 3: "E", 4: (24.0, 56.0, 0.0)}
    raw = io.BytesIO()
    base.save(raw, "JPEG", quality=95, exif=exif)
    data = raw.getvalue()
    xmp = b'http://ns.adobe.com/xap/1.0/\x00<xmp>synthetic-location</xmp>'
    data = data[:2] + b'\xff\xe1' + (len(xmp)+2).to_bytes(2, 'big') + xmp + data[2:]
    name = f"orientation-{orientation}.jpg"
    (out/name).write_bytes(data)
    with Image.open(io.BytesIO(data)) as source:
        assert source.getexif().get_ifd(34853), "Fixture must contain GPS"
        oriented = ImageOps.exif_transpose(source)
        fixtures.append({"name": name, "mime": "image/jpeg", "metadata": True,
                         "expectedSize": list(oriented.size), "corners": corners(oriented)})

for fmt, ext, mime in [("PNG", "png", "image/png"), ("WEBP", "webp", "image/webp")]:
    name = f"quadrants.{ext}"
    base.save(out/name, fmt)
    fixtures.append({"name": name, "mime": mime, "metadata": False,
                     "expectedSize": list(base.size), "corners": corners(base)})

noise = Image.frombytes("RGB", (3000, 2000), random.Random(1729).randbytes(3000*2000*3))
noise.save(out/"noise.jpg", "JPEG", quality=98)
fixtures.append({"name": "noise.jpg", "mime": "image/jpeg", "metadata": False,
                 "expectedSize": [3000, 2000], "corners": None})
noise = Image.frombytes("RGB", (1600, 1600), random.Random(42).randbytes(1600*1600*3))
noise.save(out/"dense-noise.jpg", "JPEG", quality=98)
fixtures.append({"name": "dense-noise.jpg", "mime": "image/jpeg", "metadata": False,
                 "expectedSize": [1600, 1600], "corners": None, "mustReduceDimensions": True})
base.resize((24, 18)).save(out/"small.png", "PNG")
fixtures.append({"name": "small.png", "mime": "image/png", "metadata": False,
                 "expectedSize": [24, 18], "corners": None})
(out/"fixtures.json").write_text(json.dumps(fixtures, indent=2)+"\n")
print(json.dumps({"fixtures": len(fixtures), "gpsOrientations": 8}))
