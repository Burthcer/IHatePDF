/**
 * PDF to PowerPoint backgrounds: the page with every glyph removed, TypeScript engine vs Rust (PDFium).
 * Checks per page: text left (chars, MuPDF) and pixel difference between the two backgrounds.
 *   cd crates/ihp-core && cargo build --release
 *   PY=<python> npx tsx scripts/test-strip-rust.ts [file.pdf ...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { openPdf } from '../src/services/pdfLoader';
import { analyzePage, applyPageEdits } from '../src/features/editPdf/engine/rewrite';

const OUT = resolve('test-fixtures/strip-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-strip.exe');
const DLL = resolve('src-tauri/resources/pdfium.dll');
const PY = process.env.PY ?? 'python';
const files = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ['test-fixtures/complex/complex.pdf', 'test-fixtures/scans/journal_10p.pdf', 'test-fixtures/quality/q_word.pdf', 'test-fixtures/sample-multi.pdf'];

const pairs: string[] = [];
for (const f of files) {
  const name = basename(f, '.pdf');
  const src = readFileSync(resolve(f));
  const doc = await openPdf(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer);
  const pages = doc.getPages();
  for (let i = 0; i < pages.length; i++) {
    const { blocks } = analyzePage(pages[i], i);
    await applyPageEdits(doc, pages[i], { pageIndex: i, blocks: blocks.map((b) => ({ id: b.id, deleted: true })), images: [], texts: [], addedImages: [], shapes: [] });
  }
  const ts = resolve(OUT, `ts_${name}.pdf`);
  const rs = resolve(OUT, `rs_${name}.pdf`);
  writeFileSync(ts, await doc.save({ useObjectStreams: false }));
  const run = spawnSync(CLI, [DLL, resolve(f), rs], { encoding: 'utf8' });
  console.log(name, run.status === 0 ? `rust ${run.stdout.trim()}` : `rust FALLS BACK TO TS (${run.stderr.trim()})`);
  if (run.status === 0) pairs.push(`${name}|${ts}|${rs}|${resolve(f)}`);
}
const check = spawnSync(PY, ['-c', `
import sys, pymupdf
for a in sys.argv[1:]:
    name, ts, rs, orig = a.split('|')
    d = [pymupdf.open(p) for p in (orig, ts, rs)]
    n = min(len(x) for x in d)
    for i in range(min(n, 5)):
        pm = [x[i].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY) for x in d[1:]]
        s = [x[i].get_text().strip() for x in d]
        a_, b_ = pm[0].samples, pm[1].samples
        same = pm[0].width == pm[1].width and pm[0].height == pm[1].height
        diff = sum(abs(p - q) > 24 for p, q in zip(a_, b_)) / len(a_) * 100 if same else -1
        print(f'{name} p{i+1}: text chars orig={len(s[0])} ts={len(s[1])} rust={len(s[2])}  bg pixel diff ts vs rust = {diff:.2f}%')
`, ...pairs], { encoding: 'utf8' });
console.log(check.stdout + check.stderr);
