"""Compares the PDF-to-Markdown/Word/Excel outputs of the PDFium route and the pdf.js route
(scripts/e2e/layout-ab.mjs): same words in the same order, same structure.  Usage: python scripts/layout-ab-compare.py"""
import re, zipfile
from pathlib import Path
from difflib import SequenceMatcher

root = Path('test-fixtures/layout-ab')
def words(s): return re.findall(r'\S+', s)
def docx_text(p):
    x = zipfile.ZipFile(p).read('word/document.xml').decode('utf8')
    paras = re.findall(r'<w:p[ >].*?</w:p>', x, flags=re.S)
    return [''.join(re.findall(r'<w:t[^>]*>([^<]*)</w:t>', q)) for q in paras]
def xlsx_cells(p):
    z = zipfile.ZipFile(p)
    shared = re.findall(r'<t[^>]*>([^<]*)</t>', z.read('xl/sharedStrings.xml').decode('utf8')) if 'xl/sharedStrings.xml' in z.namelist() else []
    return shared
bad = 0
for f in sorted((root / 'native').iterdir()):
    g = root / 'pdfjs' / f.name
    if not g.exists():
        print('MISSING pdfjs', f.name); continue
    if f.suffix == '.md':
        a, b = f.read_text(encoding='utf8'), g.read_text(encoding='utf8')
        r = SequenceMatcher(None, words(a), words(b), autojunk=False).ratio()
        same = a == b
        struct = (len(re.findall(r'^#', a, re.M)), len(re.findall(r'^\|', a, re.M))) == (len(re.findall(r'^#', b, re.M)), len(re.findall(r'^\|', b, re.M)))
        info = f'words {r:.3f}, identical {same}, headings/table rows equal {struct}'
        ok = r > 0.97 and struct
    elif f.suffix == '.docx':
        a, b = docx_text(f), docx_text(g)
        r = SequenceMatcher(None, ' '.join(a).split(), ' '.join(b).split(), autojunk=False).ratio()
        info = f'paragraphs {len(a)} vs {len(b)}, words {r:.3f}'
        ok = r > 0.97 and abs(len(a) - len(b)) <= max(2, len(b) * 0.1)
    else:
        a, b = xlsx_cells(f), xlsx_cells(g)
        info = f'cell strings {len(a)} vs {len(b)}, equal {a == b}'
        ok = a == b or abs(len(a) - len(b)) <= max(2, len(b) * 0.1)
    print(('ok   ' if ok else 'DIFF ') + f.name.ljust(22) + info)
    bad += not ok
print(f'{bad} differing')
