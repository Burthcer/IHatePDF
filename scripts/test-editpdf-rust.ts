/**
 * PDF to PowerPoint text boxes: TypeScript engine (editPdf/engine analyzePage) vs Rust (crates/ihp-core/src/editpdf.rs).
 * Compares, per page, the number of boxes and every field: text lines, font, size, colour, bold/italic, alignment,
 * rotation (exact) and position/size/line height (within 0.01 pt).
 *   cd crates/ihp-core && cargo build --release
 *   npx tsx scripts/test-editpdf-rust.ts [file.pdf | dir ...]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { openPdf } from '../src/services/pdfLoader';
import { analyzePage } from '../src/features/editPdf/engine/rewrite';
import { blocksToPptBoxes } from '../src/features/pdfToPpt/textBoxes';

const OUT = resolve('test-fixtures/editpdf-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-editpdf.exe');
const TOL = 0.01;

const defaults = ['test-fixtures/complex/complex.pdf', 'test-fixtures/complex/edit_replace.pdf', 'test-fixtures/complex/complex_pdfa.pdf', 'test-fixtures/quality/q_word.pdf', 'test-fixtures/sample-multi.pdf', 'test-fixtures/scans/journal_10p.pdf', 'test-fixtures/edge/form_xobject.pdf', 'test-fixtures/edge/gray_rotated.pdf', 'test-fixtures/docx-rust', 'test-fixtures/pptx-rust', 'test-fixtures/xlsx-rust', 'test-fixtures/html-rust', 'test-fixtures/stamp-rust', 'test-fixtures/pdfppt-rust'];
const args = process.argv.slice(2);
const inputs: string[] = [];
for (const a of args.length ? args : defaults) {
  if (!existsSync(a)) continue;
  if (statSync(a).isDirectory()) {
    for (const f of readdirSync(a).sort()) if (/^(ts_|in_|src_)?.*\.pdf$/i.test(f) && !/^rs_/.test(f) && statSync(join(a, f)).size < 8e6) inputs.push(join(a, f));
  } else inputs.push(a);
}

type Box = Record<string, unknown>;
const NUM = ['x', 'y', 'width', 'height', 'fontSize', 'lineHeight'];
function diffBoxes(a: Box[], b: Box[]): string[] {
  const out: string[] = [];
  if (a.length !== b.length) return [`${a.length} boxes (TS) vs ${b.length} (Rust)`];
  a.forEach((x, i) => {
    for (const k of new Set([...Object.keys(x), ...Object.keys(b[i])])) {
      const u = x[k], v = b[i][k];
      if (NUM.includes(k)) {
        if (u === undefined && v === undefined) continue;
        if (typeof u !== 'number' || typeof v !== 'number' || Math.abs(u - v) > TOL) out.push(`box ${i} ${k}: ${u} vs ${v}`);
      } else if (JSON.stringify(u) !== JSON.stringify(v)) out.push(`box ${i} ${k}: ${JSON.stringify(u)} vs ${JSON.stringify(v)}`);
    }
  });
  return out;
}

let tsMs = 0, rsMs = 0, rsCoreMs = 0;
let pass = 0, fail = 0, fallback = 0, boxesTotal = 0, pagesTotal = 0;
const rows: string[] = [];
for (const f of inputs) {
  const name = basename(f, '.pdf');
  const src = readFileSync(resolve(f));
  let ts: Box[][];
  const t0 = performance.now();
  try {
    const doc = await openPdf(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer);
    ts = doc.getPages().map((p, i) => JSON.parse(JSON.stringify(blocksToPptBoxes(analyzePage(p, i).blocks))) as Box[]);
  } catch (e) {
    rows.push(`SKIP ${name}: TypeScript engine failed (${(e as Error).message.slice(0, 60)})`);
    continue;
  }
  tsMs += performance.now() - t0;
  const rsPath = resolve(OUT, `rs_${name}.json`);
  const t1 = performance.now();
  const run = spawnSync(CLI, [resolve(f), rsPath], { encoding: 'utf8' });
  rsMs += performance.now() - t1;
  rsCoreMs += Number(run.stdout.trim().split(' ')[2] ?? 0);
  if (run.status !== 0) {
    fallback++;
    rows.push(`FALLBACK ${name}: Rust declined (${run.stderr.trim().slice(0, 80)})`);
    continue;
  }
  const rs = (JSON.parse(readFileSync(rsPath, 'utf8')) as Array<{ boxes: Box[] }>).map((p) => p.boxes);
  const problems: string[] = [];
  if (rs.length !== ts.length) problems.push(`${ts.length} pages (TS) vs ${rs.length}`);
  else ts.forEach((tp, i) => problems.push(...diffBoxes(tp, rs[i]).map((d) => `p${i + 1} ${d}`)));
  const boxes = ts.reduce((n, p) => n + p.length, 0);
  boxesTotal += boxes;
  pagesTotal += ts.length;
  writeFileSync(resolve(OUT, `ts_${name}.json`), JSON.stringify(ts));
  if (problems.length) { fail++; rows.push(`FAIL ${name}: ${problems.length} differences, first: ${problems.slice(0, 3).join(' | ')}`); }
  else { pass++; rows.push(`PASS ${name}: ${ts.length} pages, ${boxes} boxes identical`); }
}
console.log(rows.join('\n'));
console.log(`\n${pass} pass, ${fail} fail, ${fallback} fall back to TypeScript; ${pagesTotal} pages, ${boxesTotal} boxes compared`);
console.log(`time: TypeScript ${(tsMs / 1000).toFixed(1)} s, Rust ${(rsMs / 1000).toFixed(1)} s incl. starting a process per file, ${(rsCoreMs / 1000).toFixed(1)} s for the work itself (${(tsMs / rsCoreMs).toFixed(1)}x vs TypeScript)`);
process.exit(fail ? 1 : 0);
