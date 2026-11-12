"""Compares a pptxgenjs deck (TS) with the Rust one: package validity, then slides, pictures and text boxes.
usage: py test-pdfppt-compare.py name ts.pptx rust.pptx
"""
import hashlib, posixpath, sys, zipfile
from xml.dom import minidom
from pptx import Presentation
from pptx.util import Emu

name, ts_path, rs_path = sys.argv[1:4]
problems = []


def bad(msg):
    problems.append(msg)


def package_check(path):
    z = zipfile.ZipFile(path)
    names = set(z.namelist())
    if z.testzip():
        bad(f'{path}: corrupt zip entry')
    if z.namelist()[0] != '[Content_Types].xml':
        bad('[Content_Types].xml is not the first entry')
    for n in names:
        if n.endswith('.xml') or n.endswith('.rels'):
            try:
                minidom.parseString(z.read(n))
            except Exception as e:
                bad(f'{n}: XML not well-formed ({e})')
    ct = minidom.parseString(z.read('[Content_Types].xml'))
    defaults = {e.getAttribute('Extension').lower() for e in ct.getElementsByTagName('Default')}
    overrides = {e.getAttribute('PartName') for e in ct.getElementsByTagName('Override')}
    for o in overrides:
        if o.lstrip('/') not in names:
            bad(f'content type override for missing part {o}')
    for n in names:
        if n == '[Content_Types].xml':
            continue
        if '/' + n not in overrides and n.rsplit('.', 1)[-1].lower() not in defaults:
            bad(f'no content type for {n}')
    for n in names:
        if not n.endswith('.rels'):
            continue
        base = posixpath.dirname(posixpath.dirname(n))
        for r in minidom.parseString(z.read(n)).getElementsByTagName('Relationship'):
            if r.getAttribute('TargetMode') == 'External':
                continue
            t = r.getAttribute('Target')
            target = t.lstrip('/') if t.startswith('/') else posixpath.normpath(posixpath.join(base, t))
            if target not in names:
                bad(f'{n}: relationship {r.getAttribute("Id")} points to missing {target}')
    return z


def para_props(p):
    ppr = p._p.pPr
    ln = ppr.find('{http://schemas.openxmlformats.org/drawingml/2006/main}lnSpc') if ppr is not None else None
    sp = None
    if ln is not None and len(ln):
        sp = ln[0].get('val')
    return sp


def describe(path):
    prs = Presentation(path)
    out = {'size': (prs.slide_width, prs.slide_height), 'slides': []}
    for s in prs.slides:
        items = []
        for sh in s.shapes:
            d = {'kind': sh.shape_type.__str__().split('.')[-1].split(' ')[0], 'pos': (sh.left, sh.top, sh.width, sh.height), 'rot': sh.rotation}
            if sh.shape_type is not None and 'PICTURE' in str(sh.shape_type):
                d['kind'] = 'PICTURE'
                d['sha'] = hashlib.sha1(sh.image.blob).hexdigest()
                d['ctype'] = sh.image.content_type
            elif sh.has_text_frame:
                d['kind'] = 'TEXT'
                paras = []
                for p in sh.text_frame.paragraphs:
                    runs = []
                    for r in p.runs:
                        f = r.font
                        runs.append((r.text, f.size.pt if f.size else None, bool(f.bold), bool(f.italic), str(f.color.rgb) if f.color and f.color.type else None, f.name))
                    paras.append((str(p.alignment), para_props(p), runs))
                d['paras'] = paras
            items.append(d)
        out['slides'].append(items)
    return out


for p in (rs_path,):  # pptxgenjs output has known quirks (directory entries, ghost slideMaster2): only the Rust package is validated
    z = package_check(p)
ts, rs = describe(ts_path), describe(rs_path)

if ts['size'] != rs['size']:
    bad(f'slide size ts={ts["size"]} rust={rs["size"]}')
if len(ts['slides']) != len(rs['slides']):
    bad(f'slide count ts={len(ts["slides"])} rust={len(rs["slides"])}')
nshape = ntext = npic = 0
for i, (a, b) in enumerate(zip(ts['slides'], rs['slides'])):
    if len(a) != len(b):
        bad(f'slide {i+1}: shapes ts={len(a)} rust={len(b)}')
        continue
    for j, (x, y) in enumerate(zip(a, b)):
        nshape += 1
        ntext += x['kind'] == 'TEXT'
        npic += x['kind'] == 'PICTURE'
        for k in x:
            if x[k] != y.get(k):
                bad(f'slide {i+1} shape {j} ({x["kind"]}): {k} ts={str(x[k])[:200]} rust={str(y.get(k))[:200]}')

print(f'{name}: slides={len(rs["slides"])} shapes={nshape} (text={ntext}, pictures={npic}) size={rs["size"]} package ok={not any("XML" in m or "content type" in m or "relationship" in m for m in problems)}')
if problems:
    for m in problems[:15]:
        print('  DIFF', m)
    print(f'  {len(problems)} differences')
    sys.exit(1)
print('  identical: slide size, shape order, picture bytes, text, runs (size/bold/italic/colour/font), alignment, line spacing, positions (EMU), rotation')
