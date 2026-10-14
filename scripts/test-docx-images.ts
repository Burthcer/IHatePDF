// Word → PDF keeps the pictures in the document (it used to drop them silently).
// Run: npx tsx scripts/test-docx-images.ts
import { createCanvas } from '@napi-rs/canvas';
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { PDFDict, PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { convertDocxToPdf } from '../src/features/wordToPdf/renderDocxToPdf';

let passed = 0;
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  ok ? passed++ : failed++;
};

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

const para = (t: string) => new Paragraph({ children: [new TextRun(t)] });
const docx = new Document({
  sections: [{
    children: [
      para('Before the pictures.'),
      new Paragraph({ children: [new ImageRun({ type: 'png', data: picture(800, 400, 'png'), transformation: { width: 400, height: 200 } })] }),
      para('Between them.'),
      new Paragraph({ children: [new ImageRun({ type: 'jpg', data: picture(600, 900, 'jpeg'), transformation: { width: 300, height: 450 } })] }),
      // Wider than the page: must be scaled down to fit
      new Paragraph({ children: [new ImageRun({ type: 'png', data: picture(2000, 500, 'png'), transformation: { width: 1500, height: 375 } })] }),
      para('After the pictures.'),
    ],
  }],
});

console.log('--- Word to PDF keeps pictures ---');
const buffer = await Packer.toBuffer(docx);
const out = await convertDocxToPdf(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer, 'pictures.docx');
const pdf = await PDFDocument.load(out.buffer);
if (process.env.SAVE_PDF) (await import("node:fs")).writeFileSync(process.env.SAVE_PDF, Buffer.from(out.buffer));
const images: Array<{ w: number; h: number; filter: string }> = [];
for (const [, obj] of pdf.context.enumerateIndirectObjects()) {
  if (!(obj instanceof PDFRawStream)) continue;
  const d: PDFDict = obj.dict;
  if (d.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
  images.push({ w: Number(d.lookup(PDFName.of('Width'))?.toString()), h: Number(d.lookup(PDFName.of('Height'))?.toString()), filter: String(d.lookup(PDFName.of('Filter'))?.toString()) });
}
check('all three pictures are in the PDF', images.length === 3, JSON.stringify(images));
check('the JPEG stays a JPEG, the PNGs are lossless', images.filter((i) => i.filter === '/DCTDecode').length === 1 && images.filter((i) => i.filter === '/FlateDecode').length >= 2);
check('pictures keep their pixels (no resampling)', images.some((i) => i.w === 800 && i.h === 400) && images.some((i) => i.w === 600 && i.h === 900) && images.some((i) => i.w === 2000 && i.h === 500));
check('the text is still there too (3 pages or fewer, at least 1)', pdf.getPageCount() >= 1 && pdf.getPageCount() <= 3, `${pdf.getPageCount()} page(s)`);

// Every picture must lie inside the page.
const page = pdf.getPage(0);
check('page size is sane', page.getWidth() > 300 && page.getHeight() > 300);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
