// Stress inputs for the principal's "5 GB files, 5,000-10,000 pages" request:
//   test-fixtures/stress/stress_5GB.pdf      ~5 GB, ~1,400 scanned pages (300 dpi JPEG, each page's bytes differ)
//   test-fixtures/stress/stress_10000p.pdf   10,000 text pages (a heading, 40 lines, a table per page)
// Usage: node --max-old-space-size=8192 scripts/generateStressFixtures.mjs [5gb] [10000p]
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { closeSync, mkdirSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

const out = resolve('test-fixtures/stress');
mkdirSync(out, { recursive: true });
const want = new Set(process.argv.slice(2).length ? process.argv.slice(2) : ['5gb', '10000p']);

if (want.has('5gb')) {
  const W = 2480, H = 3508, DISTINCT = 20, TARGET = 5 * 1024 ** 3;
  console.log('making', DISTINCT, 'distinct 300 dpi JPEG pages…');
  const jpgs = [];
  for (let p = 0; p < DISTINCT; p++) {
    const c = createCanvas(W, H), g = c.getContext('2d'), im = g.createImageData(W, H), d = im.data;
    let s = (p + 7) * 2654435761 >>> 0;
    for (let y = 0, i = 0; y < H; y++) for (let x = 0; x < W; x++, i += 4) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const n = (s >>> 24) % 40;
      d[i] = 120 + 90 * Math.sin((x + p * 37) / 60) + n; d[i + 1] = 120 + 90 * Math.cos((y + p * 53) / 45) + n; d[i + 2] = ((x >> 3) ^ (y >> 3)) + n; d[i + 3] = 255;
    }
    g.putImageData(im, 0, 0);
    jpgs.push(c.toBuffer('image/jpeg', 92));
  }
  const avg = jpgs.reduce((n, j) => n + j.length, 0) / DISTINCT;
  const pages = Math.ceil(TARGET / (avg + 400));
  console.log(`pages: ${pages} (${(avg / 1048576).toFixed(1)} MB each); writing…`);

  // Written straight to disk, object by object, so memory stays small.
  const file = resolve(out, 'stress_5GB.pdf');
  const fd = openSync(file, 'w');
  let pos = 0;
  const offsets = [];
  const put = (b) => { const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'latin1'); let w = 0; while (w < buf.length) w += writeSync(fd, buf, w, buf.length - w); pos += buf.length; };
  const obj = (n, body) => { offsets[n] = pos; put(`${n} 0 obj\n${body}\nendobj\n`); };
  put('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n');
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  for (let i = 0; i < pages; i++) {
    const page = 3 + 3 * i, content = page + 1, image = page + 2;
    obj(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents ${content} 0 R /Resources << /XObject << /Im0 ${image} 0 R >> >> >>`);
    const c = 'q 595.28 0 0 841.89 0 0 cm /Im0 Do Q';
    obj(content, `<< /Length ${c.length} >>\nstream\n${c}\nendstream`);
    const jpg = jpgs[i % DISTINCT], tail = randomBytes(8); // trailing bytes after the JPEG end are ignored; they make every page's bytes differ
    offsets[image] = pos;
    put(`${image} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${W} /Height ${H} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length + 8} >>\nstream\n`);
    put(jpg); put(tail); put('\nendstream\nendobj\n');
    if (i % 200 === 0) console.log(`  ${i}/${pages}`);
  }
  obj(2, `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + 3 * i} 0 R`).join(' ')}] >>`);
  const total = 3 + 3 * pages;
  const xrefAt = pos;
  put(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let n = 1; n < total; n++) put(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  put(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  closeSync(fd);
  console.log(`stress_5GB.pdf: ${pages} pages, ${(statSync(file).size / 1024 ** 3).toFixed(2)} GB`);
}

if (want.has('10000p')) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const words = 'the lab report results of this study show that students used the tool for journals and assignments during each practical session'.split(' ');
  for (let p = 1; p <= 10000; p++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(`Chapter ${Math.ceil(p / 50)} · Page ${p}`, { x: 56, y: 790, size: 16, font: bold });
    for (let l = 0; l < 40; l++) {
      const line = Array.from({ length: 11 }, (_, k) => words[(p * 7 + l * 3 + k) % words.length]).join(' ');
      page.drawText(line, { x: 56, y: 760 - l * 14, size: 9.5, font });
    }
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) page.drawText(String((p * (r + 1) * (c + 2)) % 997), { x: 56 + c * 90, y: 170 - r * 18, size: 10, font });
    page.drawRectangle({ x: 56, y: 100, width: 360, height: 1, color: rgb(0.7, 0.7, 0.7) });
    if (p % 1000 === 0) console.log(`  ${p}/10000`);
  }
  const bytes = await doc.save({ useObjectStreams: true });
  writeFileSync(resolve(out, 'stress_10000p.pdf'), bytes);
  console.log(`stress_10000p.pdf: 10000 pages, ${(bytes.length / 1048576).toFixed(1)} MB`);
}
