"""Builds docs/benchmarks/benchmarks.csv and docs/benchmarks/index.html from docs/benchmarks/benchmarks.json.

    python scripts/build-benchmarks.py

The JSON is the single source of truth: edit it, run this, commit all three.
"""
import csv
import html
import json
import pathlib

root = pathlib.Path(__file__).resolve().parent.parent / 'docs' / 'benchmarks'
data = json.loads((root / 'benchmarks.json').read_text(encoding='utf-8'))
esc = html.escape

# ---- CSV: one flat row per measurement
with open(root / 'benchmarks.csv', 'w', newline='', encoding='utf-8') as fh:
    w = csv.writer(fh)
    w.writerow(['table', 'measurement', 'unit', 'lower_is_better', 'before_1.4.0', 'after_2.0.0', 'result', 'source'])
    for t in data['tables']:
        for r in t['rows']:
            w.writerow([t['id'], r['label'], t.get('unit', ''), t.get('lower_is_better', ''), r.get('before', ''), r.get('after', ''), r.get('result', ''), r.get('source', '')])


# ---- HTML
def bar_rows(t):
    out = []
    for r in t['rows']:
        b, a = r.get('before'), r.get('after')
        if isinstance(b, (int, float)) and isinstance(a, (int, float)):
            m = max(b, a) or 1
            ratio = ''
            if t.get('lower_is_better') and a > 0 and b > a:
                ratio = f'<span class="x">{b / a:.1f}x lower</span>' if b / a >= 1.5 else ''
            out.append(
                f'<div class="row"><div class="lab">{esc(r["label"])}</div>'
                f'<div class="bars"><div class="bar b" style="width:{b / m * 100:.1f}%"><span>{b:g}</span></div>'
                f'<div class="bar a" style="width:{max(a / m * 100, 1.5):.1f}%"><span>{a:g}</span></div></div>{ratio}</div>')
        elif 'result' in r:
            out.append(f'<div class="row res"><div class="lab">{esc(r["label"])}</div><div class="resv">{esc(r["result"])}</div></div>')
        else:
            out.append(f'<div class="row res"><div class="lab">{esc(r["label"])}</div><div class="resv">{esc(str(r.get("after", "")))}</div></div>')
    return ''.join(out)


sections = ''
for t in data['tables']:
    legend = '<p class="lg"><i class="b"></i>1.4.0 <i class="a"></i>2.0.0</p>' if any('before' in r for r in t['rows']) else ''
    notes = ''.join(f'<p class="note">{esc(n)}</p>' for n in t.get('notes', []))
    sections += f'<section id="{t["id"]}"><h2>{esc(t["title"])}</h2>{legend}{bar_rows(t)}{notes}</section>'

page = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>IHatePDF Rust Benchmarks</title>
<style>
:root{{--bg:#fbfaf7;--fg:#171612;--mut:#6b675d;--line:#e4e0d6;--card:#fff;--b:#a8a294;--a:#de3a24}}
@media (prefers-color-scheme:dark){{:root:not([data-theme="light"]){{--bg:#14130f;--fg:#f1eee6;--mut:#a39e92;--line:#2c2a23;--card:#1b1a15;--b:#6f6a5e;--a:#ff6a52}}}}
:root[data-theme="dark"]{{--bg:#14130f;--fg:#f1eee6;--mut:#a39e92;--line:#2c2a23;--card:#1b1a15;--b:#6f6a5e;--a:#ff6a52}}
*{{box-sizing:border-box}}body{{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}}
main{{max-width:880px;margin:0 auto;padding:32px 16px 64px}}
h1{{font-size:1.9rem;line-height:1.2;margin:0 0 .4rem}}h2{{font-size:1.05rem;margin:0 0 .6rem}}
.sub{{color:var(--mut);margin:0 0 1.4rem}}.sum li{{margin:.35rem 0}}
section{{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin:16px 0}}
.row{{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.4fr) auto;gap:8px 12px;align-items:center;padding:6px 0;border-top:1px solid var(--line)}}
.row:first-of-type{{border-top:0}}.lab{{font-size:.92rem}}.bars{{display:grid;gap:4px}}
.bar{{height:20px;border-radius:4px;min-width:2px;position:relative}}.bar.b{{background:var(--b)}}.bar.a{{background:var(--a)}}
.bar span{{position:absolute;left:100%;margin-left:6px;font-size:.8rem;color:var(--mut);white-space:nowrap}}
.bars{{padding-right:56px}}.x{{font-weight:600;color:var(--a);font-size:.85rem;white-space:nowrap}}
.row.res{{grid-template-columns:minmax(0,1fr) minmax(0,1.6fr)}}.resv{{font-size:.9rem;color:var(--mut)}}
.lg{{font-size:.8rem;color:var(--mut);margin:0 0 6px}}.lg i{{display:inline-block;width:10px;height:10px;border-radius:2px;margin:0 4px 0 10px}}.lg i:first-child{{margin-left:0}}
.lg i.b{{background:var(--b)}}.lg i.a{{background:var(--a)}}
.note{{font-size:.82rem;color:var(--mut);margin:.5rem 0 0}}ul{{padding-left:1.2rem}}code,pre{{font-family:ui-monospace,Consolas,monospace;font-size:.82rem}}
pre{{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;overflow:auto}}
a{{color:var(--a)}}.meta{{font-size:.85rem;color:var(--mut)}}
@media(max-width:640px){{.row{{grid-template-columns:1fr}}.row.res{{grid-template-columns:1fr}}}}
</style></head><body><main>
<h1>{esc(data["title"])}</h1>
<p class="sub">{esc(data["version_compared"]["before"])} compared with {esc(data["version_compared"]["after"])}.</p>
<section><h2>The short version</h2><ul class="sum">{''.join(f'<li>{esc(s)}</li>' for s in data["summary"])}</ul></section>
{sections}
<section><h2>What these numbers do not say</h2><ul>{''.join(f'<li>{esc(s)}</li>' for s in data["limits"])}</ul></section>
<section><h2>How to reproduce</h2><pre>{esc(chr(10).join(data["reproduce"]))}</pre>
<p class="meta">Measured on {esc(data["measured_on"]["machine"])}, {esc(data["measured_on"]["date_range"])}. {esc(data["measured_on"]["note"])}<br>
Data: <a href="benchmarks.json">benchmarks.json</a> · <a href="benchmarks.csv">benchmarks.csv</a> · details in <code>docs/testing/TEST_LOG.md</code></p></section>
</main></body></html>'''
(root / 'index.html').write_text(page, encoding='utf-8')
print('wrote benchmarks.csv and index.html')
