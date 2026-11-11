"""Compares TypeScript and Rust stamped PDFs: same pages, same text and words in the same places, same pixels.
Usage: python scripts/test-stamp-compare.py ts1.pdf rs1.pdf [ts2.pdf rs2.pdf ...]"""
import sys

import numpy as np
import pymupdf


def pix(page, zoom=1.5):
    p = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return np.frombuffer(p.samples, dtype=np.uint8).reshape(p.h, p.w, p.n).astype(float)


def psnr(a, b):
    if a.shape != b.shape:
        return 0
    m = np.mean((a - b) ** 2)
    return 99 if m == 0 else 10 * np.log10(255 * 255 / m)


bad = 0
args = sys.argv[1:]
for ts, rs in zip(args[::2], args[1::2]):
    a, b = pymupdf.open(ts), pymupdf.open(rs)
    problems = []
    if len(a) != len(b):
        problems.append(f'pages {len(a)} vs {len(b)}')
    worst = 99
    for i in range(min(len(a), len(b))):
        pa, pb = a[i], b[i]
        wa = [(w[4], round(w[0]), round(w[1])) for w in pa.get_text('words')]
        wb = [(w[4], round(w[0]), round(w[1])) for w in pb.get_text('words')]
        if wa != wb:
            diff = [x for x in wb if x not in wa][:3]
            problems.append(f'p{i + 1} words differ (e.g. {diff})')
        p = psnr(pix(pa), pix(pb))
        worst = min(worst, p)
        if p < 38:
            problems.append(f'p{i + 1} PSNR {p:.1f}')
    w = pymupdf.TOOLS.mupdf_warnings()
    if w:
        problems.append('mupdf: ' + w.replace('\n', ' | ')[:120])
    name = rs.split('\\')[-1]
    print(('FAIL ' if problems else 'ok   ') + f'{name}  worst PSNR {worst:.1f} dB' + (' :: ' + '; '.join(problems[:4]) if problems else ''))
    bad += bool(problems)
sys.exit(1 if bad else 0)
