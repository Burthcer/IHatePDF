/**
 * PDF to PowerPoint writer: pptxgenjs (TypeScript, buildPptxFromPages) vs the Rust writer (pptx_out.rs).
 * Text boxes come from the real Edit-engine analysis (as in extract.worker.ts) and go to both writers; the slide
 * pictures are the Rust/PDFium JPEGs (1600 px wide) so both decks hold the same bytes. Then python-pptx opens both
 * and compares slide size, shapes, pictures, text, run styles and positions.
 *   cd crates/ihp-core && cargo build --release
 *   PY=<python with python-pptx> npx tsx scripts/test-pdfppt-rust.ts [file.pdf ...]
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { readZip } from '../src/services/zipReader';
import { openPdf } from '../src/services/pdfLoader';
import { analyzePage } from '../src/features/editPdf/engine/rewrite';
import { buildPptxFromPages } from '../src/features/pdfToPpt/buildPptx.worker';
import type { PptTextBox } from '../src/types/worker';

const OUT = resolve('test-fixtures/pdfppt-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-pptx-out.exe');
const DLL = resolve('src-tauri/resources/pdfium.dll');
const PY = process.env.PY ?? 'py';
const files = process.argv.slice(2).length ? process.argv.slice(2) : ['test-fixtures/scans/journal_10p.pdf', 'test-fixtures/sample-multi.pdf', 'test-fixtures/quality/q_word.pdf'];

// Same mapping as extract.worker.ts.
function familyFace(fontName: string, family: 'sans' | 'serif' | 'mono'): string {
  const base = fontName.split(/[-,+]/)[0].replace(/(MT|PS|Std|Pro)$/, '').replace(/([a-z])([A-Z])/g, '$1 $2').trim();
  if (base && /^[A-Za-z ]{3,40}$/.test(base)) return base;
  return family === 'serif' ? 'Times New Roman' : family === 'mono' ? 'Courier New' : 'Arial';
}

let failed = 0;
for (const f of files) {
  const name = basename(f, '.pdf');
  const src = readFileSync(resolve(f));
  const doc = await openPdf(src.buffer.slice(src.byteOffset, src.byteOffset + src.byteLength) as ArrayBuffer);
  const pages = doc.getPages();
  const boxes: PptTextBox[][] = [];
  for (let i = 0; i < pages.length; i++) {
    const { blocks } = analyzePage(pages[i], i);
    boxes.push(
      blocks
        .filter((b) => b.text.trim())
        .map((b) => ({
          x: b.box.x, y: b.box.y, width: b.box.width, height: b.box.height,
          lines: b.lines.map((l) => l.text),
          fontSize: b.style.fontSize, color: b.style.color, bold: b.style.bold, italic: b.style.italic,
          fontFace: familyFace(b.fontName, b.style.family),
          align: b.style.align === 'justify' ? 'left' : b.style.align,
          lineHeight: b.lines.length > 1 ? b.frame.lineHeight : undefined,
          rotate: b.angle,
        }))
    );
  }
  // Sanity: unusual values the real PDFs rarely have (rotation, entities, empty line, big fonts) on the first slide.
  boxes[0].push({ x: 40.5, y: 700.25, width: 120.3, height: 9, lines: ['Edge & <case> "quoted" \'x\'', '', 'Ünïcode — 日本語'], fontSize: 13.3, color: '#aa00Ff', bold: true, italic: true, fontFace: 'Times New Roman', align: 'right', lineHeight: 15.37, rotate: 12.5 });
  const boxFile = resolve(OUT, `${name}_boxes.json`);
  writeFileSync(boxFile, JSON.stringify(boxes));
  const rs = resolve(OUT, `rs_${name}.pptx`);
  const run = spawnSync(CLI, [DLL, resolve(f), boxFile, rs], { encoding: 'utf8' });
  if (run.status !== 0) {
    console.log(`${name}: Rust FAILED (${run.stderr.trim()})`);
    failed++;
    continue;
  }
  // The pictures the Rust deck holds go into the TypeScript deck (page sizes from the Rust deck's pic extents are
  // circular, so use the PDF's own sizes, swapped for 90/270 rotation like pdf.js' viewport).
  const zip = await readZip(new Uint8Array(readFileSync(rs)));
  const slides = pages.map((p, i) => {
    const { width, height } = p.getSize();
    const rot = ((p.getRotation().angle % 360) + 360) % 360;
    const jpg = zip.get(`ppt/media/image-${i + 1}-1.jpeg`)!;
    return { dataUrl: 'data:image/jpeg;base64,' + Buffer.from(jpg).toString('base64'), widthPt: rot % 180 ? height : width, heightPt: rot % 180 ? width : height };
  });
  const ts = await buildPptxFromPages(slides, undefined, `${name}.pdf`, undefined, boxes);
  const tsPath = resolve(OUT, `ts_${name}.pptx`);
  writeFileSync(tsPath, Buffer.from(ts.buffer));
  const cmp = spawnSync(PY, [resolve('scripts/test-pdfppt-compare.py'), name, tsPath, rs], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf8' } });
  console.log(cmp.stdout + cmp.stderr);
  if (cmp.status !== 0) failed++;
}
process.exit(failed ? 1 : 0);
