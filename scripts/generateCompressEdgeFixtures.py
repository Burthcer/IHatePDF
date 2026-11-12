"""Awkward PDFs for Compress: alpha (SMask), palette, CMYK JPEG, grayscale, 4-bit, rotated page,
the same picture shown small and large, duplicated images, a picture inside a form XObject.
Writes test-fixtures/edge/*.pdf.   Needs: pip install pymupdf pillow numpy"""
import io
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image, ImageDraw

out = Path('test-fixtures/edge')
out.mkdir(parents=True, exist_ok=True)
rng = np.random.default_rng(7)


def photo(w, h, seed=0):
    y, x = np.mgrid[0:h, 0:w]
    r = 128 + 100 * np.sin(x / 37 + seed) + rng.normal(0, 6, (h, w))
    g = 128 + 100 * np.cos(y / 29 + seed) + rng.normal(0, 6, (h, w))
    b = 128 + 90 * np.sin((x + y) / 53) + rng.normal(0, 6, (h, w))
    return Image.fromarray(np.clip(np.dstack([r, g, b]), 0, 255).astype('uint8'))


def jpeg(im, q=92, **kw):
    b = io.BytesIO(); im.save(b, 'JPEG', quality=q, **kw); return b.getvalue()


def png(im):
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()


def page(doc, rect=(0, 0, 595, 842)):
    return doc.new_page(width=rect[2], height=rect[3])


def label(p, t):
    p.insert_text((40, 30), t, fontsize=12)


# 1. alpha
d = pymupdf.open()
p = page(d); label(p, 'RGBA picture with soft edges')
im = photo(1600, 1000).convert('RGBA')
a = Image.new('L', im.size, 255); ImageDraw.Draw(a).ellipse((100, 50, 1500, 950), fill=255);
mask = Image.new('L', im.size, 0); ImageDraw.Draw(mask).ellipse((100, 50, 1500, 950), fill=255)
im.putalpha(mask)
p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=png(im))
d.save(out / 'alpha.pdf', garbage=0)

# 2. palette + 1-bit/4-bit gray
d = pymupdf.open()
p = page(d); label(p, 'Palette (indexed) flat art')
pal = Image.new('RGB', (1400, 900), 'white'); dr = ImageDraw.Draw(pal)
for i in range(30): dr.rectangle((i * 45, 100 + i * 20, i * 45 + 200, 300 + i * 20), fill=((i * 37) % 256, (i * 91) % 256, (i * 53) % 256))
dr.text((50, 50), 'Indexed color text sample 12345', fill='black')
p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=png(pal.quantize(32)))
g4 = photo(1000, 700).convert('L').quantize(16).convert('L')
p.insert_image(pymupdf.Rect(40, 420, 555, 780), stream=png(g4))
d.save(out / 'palette.pdf', garbage=0)

# 3. CMYK JPEG (left alone by the Rust engine, must stay intact)
d = pymupdf.open()
p = page(d); label(p, 'CMYK JPEG')
cm = photo(1500, 1000).convert('CMYK')
p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=jpeg(cm))
d.save(out / 'cmyk.pdf', garbage=0)

# 4. gray JPEG + rotated page with the same photo small and large
d = pymupdf.open()
p = page(d); label(p, 'Gray JPEG')
p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=jpeg(photo(1800, 1200).convert('L')))
p = page(d); label(p, 'Rotated 90, the same photo large and small')
ph = jpeg(photo(2400, 1600))
p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=ph)
p.insert_image(pymupdf.Rect(40, 450, 140, 520), stream=ph)
p.set_rotation(90)
d.save(out / 'gray_rotated.pdf', garbage=0)

# 5. identical pictures embedded as separate objects (dedupe)
d = pymupdf.open()
ph = jpeg(photo(1400, 900, 2))
for i in range(4):
    p = page(d); label(p, f'Duplicate picture {i + 1}')
    p.insert_image(pymupdf.Rect(40, 60, 555, 400), stream=ph + b'\x00' * i)  # distinct bytes -> distinct objects? trailing zeros keep it valid
d.save(out / 'dups.pdf', garbage=0)

# 6. picture inside a form XObject (Rust must follow the CTM through the form)
d = pymupdf.open()
p = page(d); label(p, 'Picture drawn through a form XObject')
src = pymupdf.open(); sp = src.new_page(width=400, height=300)
sp.insert_image(pymupdf.Rect(0, 0, 400, 300), stream=jpeg(photo(2000, 1500, 3)))
p.show_pdf_page(pymupdf.Rect(40, 60, 555, 445), src, 0)
d.save(out / 'form_xobject.pdf', garbage=0)
print('wrote', *sorted(f.name for f in out.glob('*.pdf')))
