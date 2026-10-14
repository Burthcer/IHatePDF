"""Scores how much Compress changed each picture: SSIM and PSNR of the compressed picture
(scaled back up to the original size) against the original, plus how sharp its edges stayed.
Higher is better; SSIM 1.0 = identical. About 0.95+ looks the same to the eye; below 0.85
text in pictures starts to look soft or blocky.
Needs: pip install pillow numpy pymupdf
Usage: py scripts/e2e/quality_score.py [out_dir=test-fixtures/quality/out]   (writes quality_scores.md there)
"""
import io, re, sys
from pathlib import Path

import numpy as np
import pymupdf
from PIL import Image

root = Path('test-fixtures/quality')
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'out'
src = root / 'src'


def box_mean(a, k):
    p = k // 2
    a = np.pad(a, p, mode='reflect')
    c = a.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return s / (k * k)


def ssim(a, b, k=7):
    a = a.astype(np.float64); b = b.astype(np.float64)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    ma, mb = box_mean(a, k), box_mean(b, k)
    va, vb, cov = box_mean(a * a, k) - ma * ma, box_mean(b * b, k) - mb * mb, box_mean(a * b, k) - ma * mb
    return float(np.mean(((2 * ma * mb + c1) * (2 * cov + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2))))


def psnr(a, b):
    mse = np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2)
    return 99.0 if mse == 0 else float(10 * np.log10(255 ** 2 / mse))


def edge_energy(g):
    gx, gy = np.diff(g.astype(np.float64), axis=1), np.diff(g.astype(np.float64), axis=0)
    return float(np.mean(np.abs(gx)) + np.mean(np.abs(gy)))


def biggest_image(pdf):
    doc = pymupdf.open(pdf)
    best = None
    for page in doc:
        for im in page.get_images(full=True):
            info = doc.extract_image(im[0])
            if best is None or info['width'] * info['height'] > best[0] * best[1]:
                best = (info['width'], info['height'], info['image'], info.get('ext'))
    return best


rows = []
for f in sorted(out.glob('q_*__*.pdf')):
    base, preset = f.stem.split('__', 1)
    orig = next(iter(src.glob(base.replace('q_word', 'q_screenshot') + '.*')), None)
    if orig is None:
        continue
    o = Image.open(orig).convert('L')
    got = biggest_image(f)
    if not got:
        continue
    w, h, data, ext = got
    c = Image.open(io.BytesIO(data)).convert('L')
    cs = c.resize(o.size, Image.BICUBIC)
    oa, ca = np.array(o), np.array(cs)
    rows.append((base.replace('q_', ''), preset, f'{w}×{h}', ext, f.stat().st_size / 1024, ssim(oa, ca), psnr(oa, ca), edge_energy(ca) / max(1e-9, edge_energy(oa))))

lines = ['| Picture | Setting | Stored as | Format | File KB | SSIM | PSNR dB | Edge sharpness kept |', '|---|---|---|---|---|---|---|---|']
for r in rows:
    lines.append(f'| {r[0]} | {r[1]} | {r[2]} | {r[3]} | {r[4]:.0f} | {r[5]:.3f} | {r[6]:.1f} | {r[7] * 100:.0f}% |')
text = '\n'.join(lines)
(out / 'quality_scores.md').write_text(text, encoding='utf-8')
print(text)
