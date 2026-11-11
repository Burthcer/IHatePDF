/**
 * Rust stamp tools (watermark, page numbers, sign) against the TypeScript workers: runs both on the
 * same input with the same payload, then compares the pages (pixels) and the text with MuPDF.
 *   cd crates/ihp-core && cargo build --release
 *   npx tsx scripts/test-stamp-rust.ts        (needs pymupdf, numpy: PY=<python>)
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { addPageNumbers } from '../src/features/pageNumbers/pageNumbers.worker';
import { applyWatermark } from '../src/features/watermark/watermark.worker';
import { stampSignature } from '../src/features/sign/sign.worker';

const OUT = resolve('test-fixtures/stamp-rust');
mkdirSync(OUT, { recursive: true });
const CLI = resolve('crates/ihp-core/target/release/ihp-stamp.exe');
const PY = process.env.PY ?? 'python';
const inputs = { journal: resolve('test-fixtures/scans/journal_10p.pdf'), complex: resolve('test-fixtures/complex/complex.pdf'), rotated: resolve('test-fixtures/edge/gray_rotated.pdf') };

const ab = (path: string) => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

function png(w: number, h: number): Buffer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  g.clearRect(0, 0, w, h);
  g.fillStyle = 'rgba(200,30,30,0.85)';
  g.fillRect(w * 0.1, h * 0.2, w * 0.8, h * 0.6);
  g.fillStyle = '#123';
  g.font = `${h / 3}px sans-serif`;
  g.fillText('Sig', w * 0.2, h * 0.65);
  return c.toBuffer('image/png');
}
const SIG = png(400, 160);
writeFileSync(resolve(OUT, 'sig.png'), SIG);

type Case = { name: string; input: keyof typeof inputs; op: 'pagenumbers' | 'watermark' | 'sign'; payload: Record<string, unknown>; image?: string };
const cases: Case[] = [
  { name: 'num_plain', input: 'journal', op: 'pagenumbers', payload: { format: 'n', position: 'bottom-center', fontSize: 11, color: '#333333', marginMm: 12, startPage: 1, startingNumber: 1 } },
  { name: 'num_of_total_mirror', input: 'journal', op: 'pagenumbers', payload: { format: 'n_of_total', position: 'bottom-right', fontSize: 10, color: '#ff0000', marginMm: 8, startPage: 2, endPage: 9, startingNumber: 5, mirror: true } },
  { name: 'num_roman_template', input: 'journal', op: 'pagenumbers', payload: { format: 'roman', template: 'p. {roman} of {total} ({n})', position: 'top-left', fontSize: 9, color: '#000', marginMm: 15, startPage: 1, startingNumber: 1 } },
  { name: 'num_rotated_cropped', input: 'complex', op: 'pagenumbers', payload: { format: 'n', position: 'bottom-center', fontSize: 14, color: '#0000ff', marginMm: 10, startPage: 1, startingNumber: 1 } },
  { name: 'num_rotated_pages', input: 'rotated', op: 'pagenumbers', payload: { format: 'n_of_total', position: 'top-right', fontSize: 12, color: '#006600', marginMm: 10, startPage: 1, startingNumber: 1 } },
  { name: 'wm_center', input: 'journal', op: 'watermark', payload: { mode: 'text', text: 'CONFIDENTIAL', fontSize: 60, color: '#cc0000', opacity: 0.25, rotationDegrees: 45, position: 'center', layer: 'above', bold: true, fontFamily: 'sans' } },
  { name: 'wm_below_serif_pages', input: 'journal', op: 'watermark', payload: { mode: 'text', text: 'DRAFT\nDo not copy', fontSize: 40, color: '#444444', opacity: 0.4, rotationDegrees: 20, position: 'top-left', layer: 'below', bold: false, fontFamily: 'serif', pageIndices: [0, 2, 3] } },
  { name: 'wm_tile', input: 'journal', op: 'watermark', payload: { mode: 'text', text: 'COPY', fontSize: 30, color: '#999999', opacity: 0.2, rotationDegrees: 30, position: 'center', layer: 'above', tile: true, bold: true, fontFamily: 'mono' } },
  { name: 'wm_rotated_page', input: 'rotated', op: 'watermark', payload: { mode: 'text', text: 'SAMPLE', fontSize: 50, color: '#0055aa', opacity: 0.3, rotationDegrees: 0, position: 'bottom-right', layer: 'above', bold: true, fontFamily: 'sans' } },
  { name: 'wm_image_png', input: 'journal', op: 'watermark', payload: { mode: 'image', imageType: 'png', fontSize: 40, color: '#000', opacity: 0.5, rotationDegrees: 15, position: 'center', layer: 'above', imageScale: 0.4 }, image: 'sig.png' },
  { name: 'wm_image_tile', input: 'complex', op: 'watermark', payload: { mode: 'image', imageType: 'png', fontSize: 40, color: '#000', opacity: 0.3, rotationDegrees: 0, position: 'center', layer: 'below', tile: true, imageScale: 0.25 }, image: 'sig.png' },
  { name: 'sign_upright', input: 'journal', op: 'sign', payload: { placements: [{ pageIndex: 0, x: 100, y: 600, width: 160, height: 64 }, { pageIndex: 3, x: 300, y: 100, width: 200, height: 80 }] }, image: 'sig.png' },
  { name: 'sign_rotated_cropped', input: 'rotated', op: 'sign', payload: { placements: [{ pageIndex: 0, x: 80, y: 120, width: 140, height: 56 }, { pageIndex: 1, x: 200, y: 300, width: 120, height: 48 }] }, image: 'sig.png' },
  { name: 'sign_complex', input: 'complex', op: 'sign', payload: { placements: [{ pageIndex: 0, x: 60, y: 700, width: 150, height: 60 }] }, image: 'sig.png' },
];

async function runTs(c: Case): Promise<ArrayBuffer> {
  const buf = ab(inputs[c.input]);
  const base = { fileBuffer: buf, fileName: 'x.pdf' };
  const p = c.payload as Record<string, never>;
  if (c.op === 'pagenumbers') return (await addPageNumbers({ ...base, ...p } as never)).buffer!;
  if (c.op === 'watermark') {
    const total = 10;
    const pages = (c.payload.pageIndices as number[] | undefined)?.map((i) => i + 1).join(',');
    const img = c.image ? ab(resolve(OUT, c.image)) : undefined;
    return (await applyWatermark({ ...base, ...p, pages: pages, imageBytes: img } as never)).buffer!;
    void total;
  }
  return (await stampSignature({ ...base, signatureImageBytes: ab(resolve(OUT, c.image!)), placements: (c.payload as { placements: never[] }).placements } as never)).buffer!;
}

const pairs: string[] = [];
let failed = 0;
for (const c of cases) {
  const ts = resolve(OUT, `ts_${c.name}.pdf`);
  const rs = resolve(OUT, `rs_${c.name}.pdf`);
  try {
    writeFileSync(ts, Buffer.from(await runTs(c)));
  } catch (e) {
    console.log(`SKIP ${c.name}: the TypeScript worker failed here (${(e as Error).message.slice(0, 80)})`);
    continue;
  }
  const pj = resolve(OUT, `${c.name}.json`);
  writeFileSync(pj, JSON.stringify(c.payload));
  const args = [c.op, inputs[c.input], rs, pj, ...(c.image ? [resolve(OUT, c.image)] : [])];
  const r = spawnSync(CLI, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    console.log(`FAIL ${c.name}: Rust CLI exited ${r.status}: ${r.stderr.trim()}`);
    failed++;
    continue;
  }
  pairs.push(ts, rs);
}
const py = spawnSync(PY, ['scripts/test-stamp-compare.py', ...pairs], { encoding: 'utf8' });
console.log(py.stdout + py.stderr);
process.exit(failed || py.status ? 1 : 0);
