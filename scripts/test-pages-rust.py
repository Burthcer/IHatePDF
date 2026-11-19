"""Checks the Rust page tools (crates/ihp-core, target/release/ihp-pages.exe) with MuPDF:
page counts, order (by page text), per-page pixels vs the source page, rotation, crop boxes, zip contents.
Build first: cd crates/ihp-core && cargo build --release.   Usage: python scripts/test-pages-rust.py"""
import subprocess, sys, zipfile
from pathlib import Path

import numpy as np
import pymupdf

CLI = str(Path('crates/ihp-core/target/release/ihp-pages.exe').resolve())
FX = Path('test-fixtures')
OUT = FX / 'pages-rust'
OUT.mkdir(exist_ok=True)
fails = []


def run(*args):
    r = subprocess.run([CLI, *map(str, args)], capture_output=True, text=True)
    return r.returncode, (r.stdout + r.stderr).strip()


def check(name, cond, detail=''):
    print(('ok   ' if cond else 'FAIL ') + name + (f'  [{detail}]' if detail and not cond else ''))
    if not cond:
        fails.append(name)


def pix(page, zoom=1.0):
    p = page.get_pixmap(matrix=pymupdf.Matrix(zoom, zoom), alpha=False)
    return np.frombuffer(p.samples, dtype=np.uint8).reshape(p.h, p.w, p.n).astype(float)


def psnr(a, b):
    if a.shape != b.shape:
        return 0
    m = np.mean((a - b) ** 2)
    return 99 if m == 0 else 10 * np.log10(255 * 255 / m)


def same_page(src_page, out_page, ignore_rotation=False):
    return psnr(pix(src_page), pix(out_page)) > 45


journal = FX / 'scans' / 'journal_10p.pdf'
complex_pdf = FX / 'complex' / 'complex.pdf'
rot = FX / 'edge' / 'gray_rotated.pdf'
alpha = FX / 'edge' / 'alpha.pdf'
q = FX / 'quality' / 'q_photo.pdf'

# ---- merge
out = OUT / 'merge.pdf'
code, msg = run('merge', out, journal, complex_pdf, rot, alpha)
check('merge runs', code == 0, msg)
src = [pymupdf.open(f) for f in (journal, complex_pdf, rot, alpha)]
d = pymupdf.open(out)
check('merge page count', len(d) == sum(len(s) for s in src), f'{len(d)}')
k = 0
okp = True
for s in src:
    for i in range(len(s)):
        okp &= same_page(s[i], d[k]) and s[i].get_text().split() == d[k].get_text().split() and s[i].rotation == d[k].rotation
        k += 1
check('merge keeps every page identical (pixels, text, rotation)', okp)
check('merge output is a clean PDF', not pymupdf.TOOLS.mupdf_warnings())
code, msg = run('merge', OUT / 'one.pdf', journal)
check('merge needs two files', code != 0)

# ---- organize: reorder, delete, blank, rotate
out = OUT / 'organize.pdf'
code, msg = run('extract', journal, out, '4,1,-1,0:90,9')
check('organize runs', code == 0, msg)
j = pymupdf.open(journal)
d = pymupdf.open(out)
check('organize page count', len(d) == 5, str(len(d)))
check('organize order', d[0].get_text().split() == j[4].get_text().split() and d[1].get_text().split() == j[1].get_text().split() and d[4].get_text().split() == j[9].get_text().split())
check('organize blank page has no text and the next page size', d[2].get_text().strip() == '' and abs(d[2].rect.width - j[0].rect.width) < 0.5)
check('organize rotates page 4 by 90', d[3].rotation == 90 and d[3].get_text().split() == j[0].get_text().split())
code, msg = run('extract', journal, OUT / 'empty.pdf', '-1,-1')
check('organize refuses an all-blank result', code != 0)
code, msg = run('extract', journal, OUT / 'dup.pdf', '0,0,0')
check('organize can repeat a page', code == 0 and len(pymupdf.open(OUT / 'dup.pdf')) == 3, msg)

# ---- split into zip
out = OUT / 'split.zip'
code, msg = run('splitzip', journal, out, 'journal', '0-2,3,4-9')
check('split zip runs', code == 0, msg)
z = zipfile.ZipFile(out)
names = z.namelist()
check('split names', names == ['journal_1_p1-3.pdf', 'journal_2_p4.pdf', 'journal_3_p5-10.pdf'], str(names))
parts = [pymupdf.open(stream=z.read(n), filetype='pdf') for n in names]
check('split part sizes', [len(p) for p in parts] == [3, 1, 6])
check('split part content', parts[2][0].get_text().split() == j[4].get_text().split())

# ---- rotate
out = OUT / 'rotate.pdf'
code, msg = run('rotate', rot, out, 90, '0:90')
check('rotate runs', code == 0, msg)
r0, r1 = pymupdf.open(rot), pymupdf.open(out)
check('rotate adds global + page degrees', r1[0].rotation == (r0[0].rotation + 180) % 360 and r1[1].rotation == (r0[1].rotation + 90) % 360, f'{[p.rotation for p in r0]} -> {[p.rotation for p in r1]}')
code, msg = run('rotate', complex_pdf, OUT / 'rot_c.pdf', 0, '')
c0, c1 = pymupdf.open(complex_pdf), pymupdf.open(OUT / 'rot_c.pdf')
check('rotate by zero changes nothing visible', all(same_page(c0[i], c1[i]) for i in range(len(c0))))
check('rotate keeps the form fields', (c0.is_form_pdf or 0) == (c1.is_form_pdf or 0), f'{c0.is_form_pdf} {c1.is_form_pdf}')

# ---- crop (mm, as displayed)
out = OUT / 'crop.pdf'
code, msg = run('crop', journal, out, 10, 20, 30, 40)  # top right bottom left
check('crop runs', code == 0, msg)
c = pymupdf.open(out)[0]
w0, h0 = j[0].rect.width, j[0].rect.height
mm = 72 / 25.4
check('crop size on an upright page', abs(c.rect.width - (w0 - 60 * mm)) < 0.6 and abs(c.rect.height - (h0 - 40 * mm)) < 0.6, f'{c.rect} vs {w0 - 60 * mm:.1f} x {h0 - 40 * mm:.1f}')
code, msg = run('crop', rot, OUT / 'crop_rot.pdf', 10, 0, 0, 0)  # 10 mm off the displayed top of a rotated page
r = pymupdf.open(rot)[1]
cr = pymupdf.open(OUT / 'crop_rot.pdf')[1]
check('crop on a rotated page trims the displayed top', abs((r.rect.height - cr.rect.height) - 10 * mm) < 0.6, f'{r.rect} -> {cr.rect}')
code, msg = run('crop', journal, OUT / 'crop_one.pdf', 10, 10, 10, 10, '2')
cp = pymupdf.open(OUT / 'crop_one.pdf')
check('crop only the chosen pages', cp[0].rect == j[0].rect and cp[2].rect != j[2].rect)

print(f'\n{len(fails)} failed' if fails else '\nall page-tool checks passed')
sys.exit(1 if fails else 0)
