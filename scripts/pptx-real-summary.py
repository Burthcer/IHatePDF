# Summarises scripts/test-pptx-real.ts output: python scripts/pptx-real-summary.py <output.txt> [prefix]
import re, sys
name = None; rows = []; bad = []
for l in open(sys.argv[1], encoding='utf8'):
    m = re.match(r'(\S+) pages ref/ts/rs: (\d+) (\S+) (\S+)', l)
    if m:
        name = m.group(1)
        if m.group(2) != m.group(4): bad.append((name, m.group(2), m.group(4)))
        continue
    m = re.search(r'(p\d+).*rust=([\-\d.]+)', l)
    if m: rows.append((float(m.group(2)), name, m.group(1)))
    elif 'DECLINED' in l or 'FAILED' in l: print(l.strip()[:160])
rows.sort(reverse=True)
print('page-count mismatches:', bad)
print(' '.join(f'{n[:12]}.{p}={v:.0f}' for v, n, p in rows[:int(sys.argv[2]) if len(sys.argv) > 2 else 20]))
print('mean %.2f over %d pages; pages above 15: %d' % (sum(r[0] for r in rows) / max(1, len(rows)), len(rows), sum(1 for r in rows if r[0] > 15)))
