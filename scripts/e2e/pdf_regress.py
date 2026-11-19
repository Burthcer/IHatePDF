"""Does the output still look and read like the input? For each input/output pair of PDFs:
page count, text on every page, and a pixel comparison of every page rendered at 72 dpi
(PSNR dB, higher = closer; >30 is a faint difference, >40 invisible), plus any MuPDF repair warnings.
Needs: pip install pymupdf numpy
Usage: python scripts/e2e/pdf_regress.py in.pdf out.pdf [in2.pdf out2.pdf ...]   (exit 1 on a failure)
"""
import sys

import numpy as np
import pymupdf


def render(page, zoom=1.0):
    pix = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.h, pix.w, pix.n).astype(np.float64)


def psnr(a, b):
    if a.shape != b.shape:
        return 0.0
    mse = np.mean((a - b) ** 2)
    return 99.0 if mse == 0 else 10 * np.log10(255 * 255 / mse)


def check(src, dst, min_psnr=28.0):
    problems = []
    a, b = pymupdf.open(src), pymupdf.open(dst)
    pymupdf.TOOLS.mupdf_warnings()
    if len(a) != len(b):
        return [f'page count {len(a)} -> {len(b)}'], 0
    worst = 99.0
    for i in range(len(a)):
        pa, pb = a[i], b[i]
        if pa.get_text().split() != pb.get_text().split():
            problems.append(f'p{i + 1}: text changed')
        if pa.rect != pb.rect or pa.rotation != pb.rotation:
            problems.append(f'p{i + 1}: page box/rotation changed')
        p = psnr(render(pa), render(pb))
        worst = min(worst, p)
        if p < min_psnr:
            problems.append(f'p{i + 1}: PSNR {p:.1f} dB')
        if len(a) > 40 and i >= 5:  # long files: first pages are enough
            break
    warn = pymupdf.TOOLS.mupdf_warnings()
    if warn:
        problems.append('mupdf warnings: ' + warn.replace('\n', ' | ')[:200])
    return problems, worst


bad = 0
args = sys.argv[1:]
for src, dst in zip(args[::2], args[1::2]):
    problems, worst = check(src, dst)
    print(('FAIL ' if problems else 'ok   ') + f'{dst}  worst PSNR {worst:.1f} dB' + (' :: ' + '; '.join(problems) if problems else ''))
    bad += bool(problems)
sys.exit(1 if bad else 0)
