/**
 * PowerPoint to PDF against real PowerPoint: decks built by PowerPoint itself (scripts/make-ppt-decks.ps1, with PowerPoint's
 * own PDF as <name>.ref.pdf) converted by the TypeScript and Rust engines; writes a montage per deck (reference | TS | Rust)
 * for the first pages to test-fixtures/pptx-real/out/.
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-pptx-real.ts [name ...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { convertPptxToPdf } from '../src/features/pptToPdf/pptToPdf.worker';

const DIR = resolve('test-fixtures/pptx-real');
const OUT = resolve(DIR, 'out');
mkdirSync(OUT, { recursive: true });
(globalThis as { __ihpReadFile?: (u: URL) => Promise<Uint8Array> }).__ihpReadFile = async (u) => new Uint8Array(readFileSync(u));
const CLI = resolve('crates/ihp-core/target/release/ihp-pptx.exe');
const PY = process.env.PY ?? 'python';
const only = process.argv.slice(2);
const names = readdirSync(DIR).filter((f) => f.endsWith('.pptx')).map((f) => f.replace('.pptx', '')).filter((n) => !only.length || only.some((o) => n.startsWith(o)));
for (const n of names) {
  const buf = readFileSync(resolve(DIR, `${n}.pptx`));
  if (!process.env.SKIP_TS) try {
    const r = await convertPptxToPdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, `${n}.pptx`);
    writeFileSync(resolve(OUT, `ts_${n}.pdf`), Buffer.from(r.buffer));
  } catch (e) {
    console.log(`TS FAILED ${n}: ${(e as Error).message.slice(0, 80)}`);
  }
  const r = spawnSync(CLI, [resolve(DIR, `${n}.pptx`), resolve(OUT, `rs_${n}.pdf`)], { encoding: 'utf8', env: { ...process.env, IHP_FONTS: resolve('test-fixtures/fonts') } });
  if (r.status !== 0) console.log(`RUST DECLINED ${n}: ${r.stderr.trim().slice(0, 80)}`);
}
const py = spawnSync(PY, ['-c', `
import sys, os, pymupdf
d, out = sys.argv[1], sys.argv[2]
for n in sys.argv[3:]:
    docs = [pymupdf.open(os.path.join(d, n + '.ref.pdf'))] + [pymupdf.open(os.path.join(out, p + n + '.pdf')) if os.path.exists(os.path.join(out, p + n + '.pdf')) else None for p in ('ts_', 'rs_')]
    pages = len(docs[0])
    print(n, 'pages ref/ts/rs:', pages, *(len(x) if x else '-' for x in docs[1:]))
    idx = sorted(set(round(k * (pages - 1) / max(1, min(pages, 8) - 1)) for k in range(min(pages, 8))))
    for i in idx:
        pix = []
        for x in docs:
            if x is None or i >= len(x): pix.append(None); continue
            pix.append(x[i].get_pixmap(dpi=40))
        w = max(p.width for p in pix if p); h = max(p.height for p in pix if p)
        m = pymupdf.Pixmap(pymupdf.csRGB, pymupdf.IRect(0, 0, w * 3 + 20, h))
        m.clear_with(200)
        for k, p in enumerate(pix):
            if p is None: continue
            p = pymupdf.Pixmap(pymupdf.csRGB, p)
            p.set_origin(k * (w + 10), 0)
            m.copy(p, p.irect)
        m.save(os.path.join(out, f'{n}_p{i+1}.png'))
        diffs = []
        for p in pix[1:]:
            if p is None or p.width != pix[0].width or p.height != pix[0].height: diffs.append(-1); continue
            a = pymupdf.Pixmap(pymupdf.csGRAY, pix[0]).samples; b = pymupdf.Pixmap(pymupdf.csGRAY, p).samples
            diffs.append(sum(abs(x - y) for x, y in zip(a, b)) / len(a))
        print(f'   p{i+1}: mean pixel diff vs PowerPoint  ts={diffs[0]:.1f}  rust={diffs[1]:.1f}')
`, DIR, OUT, ...names], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
