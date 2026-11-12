/**
 * Edit PDF editing half: TypeScript engine (editPdf/engine applyPageEdits) vs Rust (crates/ihp-core/src/editpdf/apply.rs).
 * Per PDF and scenario (delete, retype, move, restyle, rewrap, align, image delete/move, new text, shapes, mixed) the same
 * edits are applied by both; the edited pages are compared by their words (MuPDF) and by pixels at 72 dpi.
 *   cd crates/ihp-core && cargo build --release --bin ihp-editapply
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-editapply-rust.ts [file.pdf | dir ...]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { openPdf } from '../src/services/pdfLoader';
import { analyzePage, applyPageEdits, type PageEdits } from '../src/features/editPdf/engine/rewrite';

const OUT = resolve('test-fixtures/editapply-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-editapply.exe');
const PY = process.env.PY ?? 'python';
const MAX_PAGES = Number(process.env.PAGES ?? 3);

const defaults = ['test-fixtures/complex/complex.pdf', 'test-fixtures/complex/edit_replace.pdf', 'test-fixtures/complex/edit_added.pdf', 'test-fixtures/complex/edit_page2.pdf', 'test-fixtures/quality/q_word.pdf', 'test-fixtures/sample-multi.pdf', 'test-fixtures/scans/journal_10p.pdf', 'test-fixtures/edge/form_xobject.pdf', 'test-fixtures/edge/gray_rotated.pdf', 'test-fixtures/docx-rust', 'test-fixtures/stamp-rust'];
const args = process.argv.slice(2);
const inputs: string[] = [];
for (const a of args.length ? args : defaults) {
  if (!existsSync(a)) continue;
  if (statSync(a).isDirectory()) {
    for (const f of readdirSync(a).sort()) if (/\.pdf$/i.test(f) && !/^rs_/.test(f) && statSync(join(a, f)).size < 5e6) inputs.push(join(a, f));
  } else inputs.push(a);
}

const empty = (pageIndex: number): PageEdits => ({ pageIndex, blocks: [], images: [], texts: [], addedImages: [], shapes: [] });
type Analysis = ReturnType<typeof analyzePage>;
type Scenario = (a: Analysis, i: number) => PageEdits | null;
const editable = (a: Analysis) => a.blocks.filter((b) => b.editable);
const style = (extra: object) => ({ fontSize: 14, color: '#336699', bold: false, italic: false, align: 'left', fontChoice: 'sans', ...extra });
const scenarios: Record<string, Scenario> = {
  delete: (a, i) => (a.blocks.length ? { ...empty(i), blocks: a.blocks.slice(0, 2).map((b) => ({ id: b.id, deleted: true })) } : null),
  retype: (a, i) => {
    const b = editable(a)[0];
    return b ? { ...empty(i), blocks: [{ id: b.id, text: 'Edited: ' + b.text.slice(0, 60) + ' and more words to wrap around the line.' }] } : null;
  },
  move: (a, i) => (a.blocks.length > 1 ? { ...empty(i), blocks: [{ id: a.blocks[1].id, dx: 14, dy: 9 }] } : null),
  restyle: (a, i) => {
    const b = editable(a)[0];
    return b ? { ...empty(i), blocks: [{ id: b.id, style: { bold: true, fontSize: b.style.fontSize + 2, fontChoice: 'serif', color: '#aa2222' } }] } : null;
  },
  rewrap: (a, i) => {
    const b = editable(a).find((x) => x.lines.length > 1) ?? editable(a)[0];
    return b ? { ...empty(i), blocks: [{ id: b.id, width: Math.max(60, (b.frame.x1 - b.frame.x0) * 0.6), style: { align: 'justify' } }] } : null;
  },
  center: (a, i) => {
    const b = editable(a)[0];
    return b ? { ...empty(i), blocks: [{ id: b.id, text: b.text.slice(0, 80), style: { align: 'center' } }] } : null;
  },
  imageDelete: (a, i) => (a.model.images.length ? { ...empty(i), images: [{ id: 0, deleted: true }] } : null),
  imageMove: (a, i) => (a.model.images.length ? { ...empty(i), images: [{ id: 0, box: { x: a.model.images[0].box.x + 20, y: a.model.images[0].box.y + 12, width: a.model.images[0].box.width * 0.7, height: a.model.images[0].box.height * 0.7 } }] } : null),
  added: (a, i) => ({
    ...empty(i),
    texts: [{ id: 't1', x: 60, y: 90, width: 200, text: 'New text box: quick brown fox, jumps over the lazy dog.\nSecond paragraph.', style: style({}) as never }],
    shapes: [
      { id: 's1', kind: 'rect', x: 40, y: 200, width: 120, height: 40, fill: '#ffcc00', stroke: '#000000', strokeWidth: 2, opacity: 0.8 },
      { id: 's2', kind: 'ellipse', x: 200, y: 200, width: 100, height: 50, fill: null, stroke: '#ff0000', strokeWidth: 1.5, opacity: 1 },
      { id: 's3', kind: 'line', x: 40, y: 280, width: 200, height: 30, fill: null, stroke: '#0000ff', strokeWidth: 3, opacity: 1 },
      { id: 's4', kind: 'highlight', x: 60, y: 90, width: 180, height: 16, fill: null, stroke: null, strokeWidth: 0, opacity: 0.4 },
    ],
  }),
  mixed: (a, i) => {
    const ed = editable(a);
    if (ed.length < 2) return null;
    return {
      ...empty(i),
      blocks: [{ id: ed[0].id, text: 'Mixed edit one' }, { id: ed[1].id, dx: -8, dy: 6, style: { italic: true } }, ...(a.blocks.length > 2 ? [{ id: a.blocks[2].id, deleted: true }] : [])],
      texts: [{ id: 't1', x: 80, y: 120, width: 0, text: 'Loose text', style: style({ fontChoice: 'mono', bold: true }) as never }],
      shapes: [{ id: 's1', kind: 'rect', x: 20, y: 20, width: 60, height: 20, fill: '#00aa88', stroke: null, strokeWidth: 0, opacity: 0.5 }],
    };
  },
};

const pairs: string[] = [];
const rows: string[] = [];
let fallbacks = 0, runs = 0, tsMs = 0, rsMs = 0;
const fallbackReasons: Record<string, number> = {};
for (const f of inputs) {
  const name = basename(f, '.pdf');
  const src = readFileSync(resolve(f));
  const buf = () => src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer;
  let pageCount = 0;
  const analyses: Analysis[] = [];
  try {
    const doc = await openPdf(buf());
    pageCount = Math.min(MAX_PAGES, doc.getPageCount());
    for (let i = 0; i < pageCount; i++) analyses.push(analyzePage(doc.getPage(i), i));
  } catch (e) {
    rows.push(`SKIP ${name}: TypeScript engine failed (${(e as Error).message.slice(0, 60)})`);
    continue;
  }
  for (const [sname, make] of Object.entries(scenarios)) {
    const edits = analyses.map((a, i) => make(a, i)).filter((e): e is PageEdits => !!e);
    if (!edits.length) continue;
    const tag = `${name}__${sname}`;
    const t0 = performance.now();
    let tsOk = true;
    try {
      const doc = await openPdf(buf());
      for (const e of edits) await applyPageEdits(doc, doc.getPage(e.pageIndex), e);
      writeFileSync(join(OUT, `ts_${tag}.pdf`), await doc.save({ useObjectStreams: false }));
    } catch (e) {
      tsOk = false;
      rows.push(`TS-FAIL ${tag}: ${(e as Error).message.slice(0, 70)}`);
    }
    tsMs += performance.now() - t0;
    if (!tsOk) continue;
    writeFileSync(join(OUT, `${tag}.json`), JSON.stringify(edits));
    runs++;
    const run = spawnSync(CLI, [resolve(f), join(OUT, `rs_${tag}.pdf`), join(OUT, `${tag}.json`)], { encoding: 'utf8' });
    if (run.status !== 0) {
      fallbacks++;
      const reason = run.stderr.trim().replace(/^error: /, '').slice(0, 60);
      fallbackReasons[reason] = (fallbackReasons[reason] ?? 0) + 1;
      rows.push(`FALLBACK ${tag}: ${reason}`);
      continue;
    }
    rsMs += Number(run.stdout.trim().split(' ')[2]);
    pairs.push(`${tag}|${join(OUT, `ts_${tag}.pdf`)}|${join(OUT, `rs_${tag}.pdf`)}|${edits.map((e) => e.pageIndex).join(',')}`);
  }
}

writeFileSync(join(OUT, 'pairs.txt'), pairs.join('\n'));
const check = spawnSync(PY, ['-c', `
import sys, pymupdf
tot = bad = 0
worst = 0
for a in open(sys.argv[1], encoding='utf8').read().splitlines():
    if not a: continue
    tag, ts, rs, pages = a.split('|')
    d = [pymupdf.open(p) for p in (ts, rs)]
    for i in [int(x) for x in pages.split(',')]:
        tot += 1
        words = [sorted(w[4] for w in x[i].get_text('words')) for x in d]
        pm = [x[i].get_pixmap(dpi=72, colorspace=pymupdf.csGRAY) for x in d]
        same = pm[0].width == pm[1].width and pm[0].height == pm[1].height
        diff = sum(abs(p - q) > 24 for p, q in zip(pm[0].samples, pm[1].samples)) / len(pm[0].samples) * 100 if same else 100
        worst = max(worst, diff)
        ok = words[0] == words[1] and diff < 0.6
        if not ok:
            bad += 1
            print(f'DIFF {tag} p{i+1}: words ts={len(words[0])} rust={len(words[1])} equal={words[0]==words[1]} pixel diff={diff:.2f}%')
print(f'compared {tot} edited pages: {tot-bad} match, {bad} differ, worst pixel diff {worst:.2f}%')
`, join(OUT, 'pairs.txt')], { encoding: 'utf8', maxBuffer: 1e8 });
console.log(rows.join('\n'));
console.log(check.stdout + check.stderr);
console.log(`scenario runs: ${runs}, Rust declined (TypeScript fallback): ${fallbacks} ${JSON.stringify(fallbackReasons)}; TS ${tsMs.toFixed(0)} ms (includes loading), Rust core ${rsMs.toFixed(0)} ms`);
