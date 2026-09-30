// Inputs for the memory tests, besides the scans (scripts/generateScanFixtures.mjs),
// written to test-fixtures/memory/ (gitignored):
//   photos/p00.jpg … p29.jpg     30 phone-sized photos (Images → PDF)
//   photo_48MP.jpg               one 48-megapixel photo (Scan to PDF)
//   huge_300MP.png               one 300-megapixel image: too big to decode on small PCs
//   big.docx, big_10k_rows.xlsx, big_150_slides.pptx, long.html   Office / HTML → PDF
//   scan_50MB_protected.pdf      the 50 MB scan, password "secret123" (Unlock)
//   scan_50MB_cut90.pdf          the 50 MB scan cut off at 90% (Repair)
//
// Usage: npx tsx scripts/e2e/memory/make-inputs.ts   (after node scripts/generateScanFixtures.mjs)

import { createCanvas } from '@napi-rs/canvas';
import { Document, HeadingLevel, Packer, Paragraph, Table, TableCell, TableRow, TextRun } from 'docx';
import PptxGenJS from 'pptxgenjs';
import * as XLSX from 'xlsx';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createDeflate } from 'node:zlib';
import { protectPdf } from '../../../src/features/protect/protect.worker';

const OUT = resolve('test-fixtures/memory');
const SCANS = resolve('test-fixtures/scans');
mkdirSync(resolve(OUT, 'photos'), { recursive: true });
const done = (f: string) => console.log(`${f}: ${(statSync(resolve(OUT, f)).size / 1048576).toFixed(1)} MB`);

function photo(w: number, h: number, seed: number): Buffer {
  const c = createCanvas(w, h);
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${(seed * 37) % 360},60%,55%)`);
  grad.addColorStop(1, `hsl(${(seed * 71 + 120) % 360},50%,30%)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  for (let i = 0; i < 80; i++) {
    g.fillStyle = `hsla(${(seed * 13 + i * 29) % 360},70%,${30 + ((i * 7) % 50)}%,0.4)`;
    g.beginPath();
    g.arc(((i * 7919 + seed * 104729) % w), ((i * 6007 + seed * 1301) % h), 20 + ((i * 53) % (w / 6)), 0, Math.PI * 2);
    g.fill();
  }
  return c.encodeSync('jpeg', 85);
}

// Photos.
for (let i = 0; i < 30; i++) writeFileSync(resolve(OUT, 'photos', `p${String(i).padStart(2, '0')}.jpg`), photo(4000, 3000, i));
console.log('photos/: 30 photos (12 MP)');
writeFileSync(resolve(OUT, 'photo_48MP.jpg'), photo(8000, 6000, 99));
done('photo_48MP.jpg');

// A 300-megapixel PNG (20000 × 15000), written row by row so making it takes little memory.
{
  const W = 20000, H = 15000;
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const out = createWriteStream(resolve(OUT, 'huge_300MP.png'));
  out.write(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  out.write(chunk('IHDR', ihdr));
  // One zlib stream fed row by row; the compressed image (small: smooth colours) is collected, then written.
  const z = createDeflate({ level: 6 });
  const parts: Buffer[] = [];
  z.on('data', (d: Buffer) => parts.push(d));
  const finished = new Promise<void>((r) => z.on('end', () => r()));
  const row = Buffer.alloc(1 + W * 3);
  for (let y = 0; y < H; y++) {
    const v = Math.floor((y / H) * 255);
    for (let x = 0; x < W; x++) {
      row[1 + x * 3] = v;
      row[2 + x * 3] = (x >> 6) & 255;
      row[3 + x * 3] = 128;
    }
    if (!z.write(Buffer.from(row))) await new Promise((r) => z.once('drain', r));
  }
  z.end();
  await finished;
  out.write(chunk('IDAT', Buffer.concat(parts)));
  out.write(chunk('IEND', Buffer.alloc(0)));
  await new Promise<void>((r) => out.end(r));
  done('huge_300MP.png');
}

// Office and HTML.
const lorem = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.';
{
  const children: Array<Paragraph | Table> = [];
  for (let s = 0; s < 150; s++) {
    children.push(new Paragraph({ text: `Chapter ${s + 1}`, heading: HeadingLevel.HEADING_1 }));
    for (let p = 0; p < 8; p++) children.push(new Paragraph({ children: [new TextRun(`${lorem} `), new TextRun({ text: 'Bold part. ', bold: true }), new TextRun({ text: `Section ${s + 1}.${p + 1}.`, italics: true })] }));
    if (s % 5 === 0) children.push(new Table({ rows: Array.from({ length: 8 }, (_, r) => new TableRow({ children: Array.from({ length: 4 }, (_, c) => new TableCell({ children: [new Paragraph(`R${r}C${c}`)] })) })) }));
  }
  writeFileSync(resolve(OUT, 'big.docx'), await Packer.toBuffer(new Document({ sections: [{ children }] })));
  done('big.docx');
}
{
  const rows: unknown[][] = [['ID', 'Name', 'Region', 'Q1', 'Q2', 'Q3', 'Q4', 'Total', 'Date', 'Notes']];
  for (let i = 1; i <= 10000; i++) rows.push([i, `Student ${i}`, ['North', 'South', 'East', 'West'][i % 4], i % 97, i % 89, i % 83, i % 79, (i % 97) + (i % 89) + (i % 83) + (i % 79), `2026-0${(i % 9) + 1}-1${i % 9}`, i % 10 === 0 ? 'Needs review' : '']);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Marks');
  XLSX.writeFile(wb, resolve(OUT, 'big_10k_rows.xlsx'));
  done('big_10k_rows.xlsx');
}
{
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  for (let i = 0; i < 150; i++) {
    const s = pptx.addSlide();
    s.background = { color: i % 2 ? 'F1F5F9' : '0F172A' };
    s.addText(`Lecture slide ${i + 1}`, { x: 0.5, y: 0.4, w: 12, h: 0.8, fontSize: 32, bold: true, color: i % 2 ? '0F172A' : 'FFFFFF' });
    s.addText([{ text: 'Point one about the topic', options: { bullet: true } }, { text: 'Point two with more detail', options: { bullet: true } }, { text: lorem, options: { bullet: true } }], { x: 0.5, y: 1.5, w: 7, h: 4, fontSize: 18, color: i % 2 ? '334155' : 'E2E8F0' });
    s.addShape(pptx.ShapeType.rect, { x: 8.5, y: 1.5, w: 4, h: 3, fill: { color: 'F59E0B' } });
  }
  await pptx.writeFile({ fileName: resolve(OUT, 'big_150_slides.pptx') });
  done('big_150_slides.pptx');
}
writeFileSync(
  resolve(OUT, 'long.html'),
  `<!doctype html><html><body style="font-family:Arial;margin:30px"><h1>Long report</h1>${Array.from({ length: 3000 }, (_, i) => `<p>${i + 1}. ${lorem}</p>`).join('')}</body></html>`
);
done('long.html');

// Variants of the 50 MB scan.
const scan50 = resolve(SCANS, 'scan_50MB.pdf');
if (!existsSync(scan50)) throw new Error('Run node scripts/generateScanFixtures.mjs first (scan_50MB.pdf is missing).');
const bytes = readFileSync(scan50);
writeFileSync(resolve(OUT, 'scan_50MB_cut90.pdf'), bytes.subarray(0, Math.floor(bytes.length * 0.9)));
done('scan_50MB_cut90.pdf');
const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
const prot = await protectPdf({ fileBuffer: ab, fileName: 'scan_50MB.pdf', userPassword: 'secret123' });
writeFileSync(resolve(OUT, 'scan_50MB_protected.pdf'), new Uint8Array(prot.buffer!));
done('scan_50MB_protected.pdf');
