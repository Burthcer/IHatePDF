/**
 * PowerPoint to PDF: TypeScript engine vs Rust (crates/ihp-core/src/pptx.rs) on generated and real .pptx files;
 * compares pages, words and pixels with MuPDF (scripts/test-stamp-compare.py).
 *   cd crates/ihp-core && cargo build --release
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-pptx-rust.ts
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import PptxGenJS from 'pptxgenjs';
import { convertPptxToPdf } from '../src/features/pptToPdf/pptToPdf.worker';

const OUT = resolve('test-fixtures/pptx-rust');
mkdirSync(OUT, { recursive: true });
(globalThis as { __ihpReadFile?: (u: URL) => Promise<Uint8Array> }).__ihpReadFile = async (u) => new Uint8Array(readFileSync(u));
const FONTS = resolve('test-fixtures/fonts');
if (!existsSync(FONTS)) throw new Error('Run scripts/test-stamp-rust.ts once first (it copies the fonts to test-fixtures/fonts).');
const CLI = resolve('crates/ihp-core/target/release/ihp-pptx.exe');
const PY = process.env.PY ?? 'python';

function picture(w: number, h: number, kind: 'png' | 'jpeg') {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.fillStyle = '#336699';
  g.fillRect(0, 0, w, h);
  g.fillStyle = '#fff';
  g.font = '28px sans-serif';
  g.fillText('picture ' + kind, 20, h / 2);
  return kind === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 90);
}
const dataUri = (b: Buffer, mime: string) => `${mime};base64,${b.toString('base64')}`;
const lorem = 'The quick brown fox jumps over the lazy dog while the five boxing wizards jump quickly. ';

type Build = (p: PptxGenJS) => void;
const generated: Record<string, Build> = {
  text_styles: (p) => {
    const s = p.addSlide();
    s.addText('Quarterly Report', { x: 0.5, y: 0.3, w: 9, h: 0.8, fontSize: 36, bold: true, color: '0F172A' });
    s.addText([{ text: 'Bold ', options: { bold: true } }, { text: 'italic ', options: { italic: true } }, { text: 'red 20pt ', options: { color: 'CC0000', fontSize: 20 } }, { text: lorem.repeat(3), options: {} }], { x: 0.5, y: 1.3, w: 9, h: 2.5, fontSize: 14 });
    s.addText('Centered', { x: 0.5, y: 4, w: 9, h: 0.5, align: 'center', fontSize: 18 });
    s.addText('Right aligned', { x: 0.5, y: 4.6, w: 9, h: 0.5, align: 'right', fontSize: 18 });
    const s2 = p.addSlide();
    s2.addText('Second slide', { x: 1, y: 1, w: 8, h: 1, fontSize: 28 });
  },
  bullets: (p) => {
    const s = p.addSlide();
    s.addText([1, 2, 3, 4, 5, 6].map((i) => ({ text: `Point ${i}: ${lorem}`, options: { bullet: true, breakLine: true } })), { x: 0.5, y: 0.5, w: 6, h: 4, fontSize: 16 });
  },
  shapes: (p) => {
    const s = p.addSlide();
    s.background = { color: 'F1F5F9' };
    s.addShape('rect', { x: 0.5, y: 0.5, w: 3, h: 1.5, fill: { color: '3366FF' }, line: { color: '000000', width: 2 } });
    s.addShape('roundRect', { x: 4, y: 0.5, w: 3, h: 1.5, fill: { color: 'FFAA00' } });
    s.addShape('ellipse', { x: 0.5, y: 2.5, w: 3, h: 1.5, fill: { color: 'CC0000' }, line: { color: '111111', width: 3 } });
    s.addShape('ellipse', { x: 4, y: 2.5, w: 2, h: 2, line: { color: '009900', width: 1 } });
    s.addShape('line', { x: 0.5, y: 4.5, w: 6, h: 0, line: { color: '444444', width: 2 } });
    s.addShape('rect', { x: 7.5, y: 0.5, w: 2, h: 3, fill: { color: 'E2E8F0' }, line: { color: '64748B', width: 1 } });
    s.addText('Text in a shape', { shape: 'rect', x: 7.5, y: 3.7, w: 2, h: 1, fill: { color: 'DDEEFF' }, fontSize: 14, align: 'center' });
  },
  table: (p) => {
    const s = p.addSlide();
    const rows = [['Name', 'Qty', 'Notes'].map((t) => ({ text: t, options: { bold: true, fill: { color: 'E2E8F0' } } })), ...Array.from({ length: 6 }, (_, i) => [`Item ${i + 1}`, String(i * 3), 'A note ' + (i % 2 ? lorem.slice(0, 60) : '')])];
    s.addTable(rows as never, { x: 0.5, y: 0.5, w: 9, colW: [2, 1.5, 5.5], fontSize: 12, border: { type: 'solid', pt: 1, color: '666666' } });
  },
  pictures: (p) => {
    const s = p.addSlide();
    s.addImage({ data: dataUri(picture(800, 400, 'png'), 'image/png'), x: 0.5, y: 0.5, w: 4, h: 2 });
    s.addImage({ data: dataUri(picture(600, 900, 'jpeg'), 'image/jpeg'), x: 5.5, y: 0.5, w: 2, h: 3 });
    s.addText('Pictures above', { x: 0.5, y: 4, w: 5, h: 0.6, fontSize: 18 });
    const s2 = p.addSlide();
    s2.background = { data: dataUri(picture(1280, 720, 'png'), 'image/png') };
    s2.addText('Over a picture background', { x: 1, y: 2, w: 8, h: 1, fontSize: 28, color: 'FFFFFF' });
  },
  four_by_three: (p) => {
    p.layout = 'LAYOUT_4x3';
    for (let i = 1; i <= 5; i++) {
      const s = p.addSlide();
      s.background = { color: i % 2 ? 'FFFFFF' : 'FFF7E6' };
      s.addText(`Slide ${i}`, { x: 0.5, y: 0.4, w: 8, h: 0.8, fontSize: 30, bold: true });
      s.addText(lorem.repeat(i), { x: 0.5, y: 1.5, w: 8, h: 3, fontSize: 15 });
    }
  },
  greek_cyrillic: (p) => {
    const s = p.addSlide();
    s.addText('Έκθεση / Отчёт', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 30, bold: true });
    s.addText('Γειά σου κόσμε. Привет, мир! ' + 'Ελληνικά και русский текст. '.repeat(6), { x: 0.5, y: 1.8, w: 9, h: 3, fontSize: 16 });
  },
  cjk: (p) => {
    const s = p.addSlide();
    s.addText('季度报告 日本語', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 30, bold: true });
    s.addText('这是一个测试文档。' + '中文和日本語のテキスト。'.repeat(8), { x: 0.5, y: 1.8, w: 9, h: 3, fontSize: 16 });
  },
  devanagari: (p) => {
    const s = p.addSlide();
    s.addText('रिपोर्ट सारांश', { x: 0.5, y: 0.5, w: 9, h: 1, fontSize: 30, bold: true });
    s.addText('यह एक परीक्षण दस्तावेज़ है। ' + 'हिन्दी में क्रिया और पृष्ठ संख्या। '.repeat(6), { x: 0.5, y: 1.8, w: 9, h: 3, fontSize: 16 });
  },
  many_slides: (p) => {
    for (let i = 1; i <= 25; i++) {
      const s = p.addSlide();
      s.addText(`Slide ${i}`, { x: 0.5, y: 0.4, w: 8, h: 0.8, fontSize: 30, bold: true });
      s.addShape('rect', { x: 0.5, y: 1.5, w: 2 + (i % 5), h: 1, fill: { color: (i * 9000).toString(16).padStart(6, '0').slice(-6) } });
    }
  },
};

const real = ['test-fixtures/pptx-rust/hand_gradient.pptx', 'test-fixtures/sample-presentation.pptx', 'test-fixtures/test-slides.pptx', 'test-fixtures/e2e-out/out.pptx', 'test-fixtures/pdfppt-rust/probe.pptx'].filter(existsSync);

const jobs: Array<{ name: string; path: string }> = [];
for (const [name, build] of Object.entries(generated)) {
  const p = new PptxGenJS();
  build(p);
  const path = resolve(OUT, `${name}.pptx`);
  writeFileSync(path, (await p.write({ outputType: 'nodebuffer' })) as Buffer);
  jobs.push({ name, path });
}
for (const r of real) {
  const name = 'real_' + r.split('/').pop()!.replace('.pptx', '').replace(/\W/g, '_') + '_' + jobs.length;
  const path = resolve(OUT, `${name}.pptx`);
  copyFileSync(r, path);
  jobs.push({ name, path });
}

const pairs: string[] = [];
let skipped = 0;
let fallback = 0;
for (const j of jobs) {
  const buf = readFileSync(j.path);
  const ts = resolve(OUT, `ts_${j.name}.pdf`);
  const rs = resolve(OUT, `rs_${j.name}.pdf`);
  try {
    const r = await convertPptxToPdf(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer, `${j.name}.pptx`);
    writeFileSync(ts, Buffer.from(r.buffer));
  } catch (e) {
    console.log(`SKIP ${j.name}: TypeScript engine failed (${(e as Error).message.slice(0, 80)})`);
    skipped++;
    continue;
  }
  const r = spawnSync(CLI, [j.path, rs], { encoding: 'utf8', env: { ...process.env, IHP_FONTS: FONTS } });
  if (r.status !== 0) {
    console.log(`FALLBACK ${j.name}: Rust declined (${r.stderr.trim()})`);
    fallback++;
    continue;
  }
  pairs.push(ts, rs);
}
const py = spawnSync(PY, ['scripts/test-stamp-compare.py', ...pairs], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
console.log(`${pairs.length / 2} compared, ${fallback} fell back, ${skipped} skipped (TypeScript failed)`);
process.exit(py.status || fallback ? 1 : 0);
