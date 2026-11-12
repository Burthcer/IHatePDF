/**
 * HTML to PDF: TypeScript writer (htmlToPdf.worker.ts) vs Rust (crates/ihp-core/src/html.rs) on hand-built
 * display lists; compares pages, words and pixels with MuPDF (scripts/test-stamp-compare.py).
 *   cd crates/ihp-core && cargo build --release
 *   PY=py PYTHONIOENCODING=utf8 npx tsx scripts/test-html-rust.ts
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { htmlToPdf } from '../src/features/htmlToPdf/htmlToPdf.worker';
import type { HtmlDisplayItem, HtmlToPdfPayload } from '../src/types/worker';

const OUT = resolve('test-fixtures/html-rust');
mkdirSync(OUT, { recursive: true });
(globalThis as { __ihpReadFile?: (u: URL) => Promise<Uint8Array> }).__ihpReadFile = async (u) => new Uint8Array(readFileSync(u));
const FONTS = resolve('test-fixtures/fonts');
if (!existsSync(FONTS)) throw new Error('Run scripts/test-stamp-rust.ts once first (it copies the fonts to test-fixtures/fonts).');
const CLI = resolve('crates/ihp-core/target/release/ihp-html.exe');
const PY = process.env.PY ?? 'python';

function picture(w: number, h: number, kind: 'png' | 'jpeg', alpha = false): ArrayBuffer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  if (!alpha) {
    g.fillStyle = '#336699';
    g.fillRect(0, 0, w, h);
  }
  g.fillStyle = alpha ? 'rgba(200,40,40,0.5)' : '#fff';
  g.beginPath();
  g.arc(w / 2, h / 2, Math.min(w, h) / 3, 0, 7);
  g.fill();
  g.fillStyle = '#fff';
  g.font = '28px sans-serif';
  g.fillText('picture ' + kind, 20, h / 2);
  const b = kind === 'png' ? c.toBuffer('image/png') : c.toBuffer('image/jpeg', 90);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

const W = 595.28, H = 841.89;
type Fam = 'sans' | 'serif' | 'mono';
/** A paragraph as one text item per word, left to right, wrapping at `maxX`. */
function para(text: string, x0: number, y0: number, o: { size?: number; family?: Fam; bold?: boolean; italic?: boolean; color?: string; maxX?: number } = {}): HtmlDisplayItem[] {
  const size = o.size ?? 12, items: HtmlDisplayItem[] = [];
  const cw = size * 0.55;
  let x = x0, y = y0;
  for (const word of text.split(' ')) {
    const wd = [...word].length * cw * (/[぀-ヿ一-鿿]/.test(word) ? 1.8 : 1);
    if (x + wd > (o.maxX ?? W - 56) && x > x0) { x = x0; y += size * 1.45; }
    items.push({ t: 'text', x, y, text: word, size, family: o.family ?? 'sans', bold: !!o.bold, italic: !!o.italic, color: o.color ?? '#222222' });
    x += wd + cw;
  }
  return items;
}
const lorem = 'The quick brown fox jumps over the lazy dog while five boxing wizards jump quickly. '.repeat(4).trim();
const png = picture(800, 400, 'png');
const base = { pageWidthPt: W, pageHeightPt: H, fileName: 'x.html' };

const cases: Record<string, HtmlToPdfPayload> = {
  families_styles: { ...base, title: 'Families & styles', images: [], pages: [{ items: [
    ...para('Sans regular ' + lorem, 56, 80), ...para('Sans bold ' + lorem, 56, 160, { bold: true, color: '#cc0000' }),
    ...para('Serif italic ' + lorem, 56, 240, { family: 'serif', italic: true, size: 14 }), ...para('Serif bold italic ' + lorem, 56, 320, { family: 'serif', bold: true, italic: true, color: '#1f5fbf' }),
    ...para('Mono regular ' + lorem, 56, 400, { family: 'mono', size: 10 }), ...para('Mono bold ' + lorem, 56, 470, { family: 'mono', bold: true, size: 9, color: '#007700' }),
    ...para('Big heading', 56, 560, { size: 30, bold: true }), ...para('Tiny print ' + lorem, 56, 620, { size: 6 }),
  ] }] },
  shapes: { ...base, images: [], pages: [{ items: [
    { t: 'rect', x: 56, y: 60, w: 480, h: 80, fill: '#fff6d6', opacity: 1 },
    { t: 'rect', x: 56, y: 160, w: 200, h: 100, fill: '#ff0000', opacity: 0.4 },
    { t: 'rect', x: 156, y: 200, w: 200, h: 100, fill: '#0000ff', opacity: 0.4 },
    { t: 'rect', x: 400, y: 160, w: 0, h: 50, fill: '#000000', opacity: 1 },
    { t: 'line', x1: 56, y1: 340, x2: 540, y2: 340, width: 2, color: '#dd3333', dashed: false },
    { t: 'line', x1: 56, y1: 360, x2: 540, y2: 360, width: 1, color: '#000000', dashed: true },
    { t: 'line', x1: 56, y1: 380, x2: 540, y2: 420, width: 3, color: '#2255aa', dashed: true },
    { t: 'line', x1: 300, y1: 430, x2: 300, y2: 600, width: 0.5, color: '#666666', dashed: false },
    ...para('Text over a background', 66, 95, { size: 14 }),
  ] }] },
  images: { ...base, images: [png, picture(600, 900, 'jpeg'), picture(300, 300, 'png', true)], pages: [{ items: [
    ...para('Before the pictures', 56, 70),
    { t: 'image', x: 56, y: 90, w: 400, h: 200, index: 0 },
    { t: 'image', x: 56, y: 310, w: 200, h: 300, index: 1 }, // JPEG: embedPng fails in the TypeScript worker, which skips it
    { t: 'rect', x: 300, y: 320, w: 200, h: 200, fill: '#ccddee', opacity: 1 },
    { t: 'image', x: 320, y: 340, w: 160, h: 160, index: 2 },
    { t: 'image', x: 56, y: 640, w: 100, h: 50, index: 0 },
  ] }] },
  multipage: { ...base, images: [png], pages: Array.from({ length: 4 }, (_, i) => ({ items: [
    { t: 'rect', x: 0, y: 0, w: W, h: 40, fill: i % 2 ? '#e2e8f0' : '#fef2f2', opacity: 1 } as HtmlDisplayItem,
    ...para(`Page ${i + 1} of 4 ` + lorem + ' ' + lorem, 56, 80 + i * 10),
    ...(i === 2 ? [{ t: 'image', x: 56, y: 400, w: 300, h: 150, index: 0 } as HtmlDisplayItem] : []),
  ] })) },
  greek_cyrillic: { ...base, images: [], pages: [{ items: [
    ...para('Έκθεση / Отчёт', 56, 80, { size: 24, bold: true }),
    ...para('Γειά σου κόσμε. Привет, мир! ' + 'Ελληνικά και русский текст. '.repeat(12), 56, 130),
    ...para('Italic Ελληνικά ' + 'λόγος '.repeat(30), 56, 330, { italic: true, color: '#7a2a8a' }),
    ...para('Latin only line stays standard font.', 56, 450, { family: 'serif' }),
  ] }] },
  devanagari: { ...base, images: [], pages: [{ items: [
    ...para('रिपोर्ट सारांश', 56, 80, { size: 24, bold: true }),
    ...para('यह एक परीक्षण दस्तावेज़ है। ' + 'हिन्दी में क्रिया और पृष्ठ संख्या। '.repeat(10), 56, 130),
  ] }] },
  cjk: { ...base, images: [], pages: [{ items: [
    ...para('季度报告 日本語', 56, 80, { size: 24, bold: true }),
    ...para('这是一个测试文档。 ' + '中文和日本語のテキスト。 '.repeat(10), 56, 130),
    ...para('Mixed Latin 和 中文 text', 56, 330, { color: '#cc5500' }),
  ] }] },
  landscape_title: { pageWidthPt: 792, pageHeightPt: 612, fileName: 'y.html', title: 'Ünïcode — 季度', images: [], pages: [{ items: [...para('Landscape letter page ' + lorem, 40, 60, { maxX: 750 })] }] },
};

const pairs: string[] = [];
for (const [name, payload] of Object.entries(cases)) {
  const ts = resolve(OUT, `ts_${name}.pdf`);
  const rs = resolve(OUT, `rs_${name}.pdf`);
  const r0 = await htmlToPdf({ ...payload, images: payload.images.map((b) => b.slice(0)) });
  writeFileSync(ts, Buffer.from(r0.buffer!));
  const json = resolve(OUT, `${name}.json`);
  writeFileSync(json, JSON.stringify(payload));
  const imgs = payload.images.map((b, i) => {
    const p = resolve(OUT, `${name}_${i}.bin`);
    writeFileSync(p, Buffer.from(b));
    return p;
  });
  const r = spawnSync(CLI, [json, rs, ...imgs], { encoding: 'utf8', env: { ...process.env, IHP_FONTS: FONTS } });
  if (r.status !== 0) {
    console.log(`FALLBACK ${name}: Rust declined (${r.stderr.trim()})`);
    continue;
  }
  pairs.push(ts, rs);
}
const py = spawnSync(PY, ['scripts/test-stamp-compare.py', ...pairs], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
process.exit(py.status ? 1 : 0);
