// Inputs for all-tools.mjs that `npm test` doesn't generate:
// test-fixtures/misc/{photo1.jpg, photo2.png, book.xlsx, page.html} and test-fixtures/big/scan_photos.pdf.
// Usage: node scripts/e2e/make-e2e-fixtures.mjs
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import * as XLSX from 'xlsx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const misc = resolve('test-fixtures/misc');
const big = resolve('test-fixtures/big');
mkdirSync(misc, { recursive: true });
mkdirSync(big, { recursive: true });

// A photo-like picture: smooth colour fields plus sensor-style noise, different per seed.
function photo(w, h, seed) {
  const c = createCanvas(w, h), g = c.getContext('2d'), im = g.createImageData(w, h), d = im.data;
  let s = (seed * 2654435761) >>> 0;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = (s >>> 24) % 48;
    d[i] = 110 + 90 * Math.sin((x + seed * 97) / 150) + n;
    d[i + 1] = 110 + 90 * Math.cos((y + seed * 61) / 110) + n;
    d[i + 2] = 90 + 70 * Math.sin((x + y) / 200) + n;
    d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  return c;
}

writeFileSync(resolve(misc, 'photo1.jpg'), photo(1600, 1200, 1).toBuffer('image/jpeg', 90));
writeFileSync(resolve(misc, 'photo2.png'), photo(1200, 900, 2).toBuffer('image/png'));

// Two sheets, 120 rows each.
const wb = XLSX.utils.book_new();
for (const name of ['Sales', 'Stock']) {
  const rows = [['#', 'Item', 'Region', 'Qty', 'Price']];
  for (let i = 1; i <= 120; i++) rows.push([i, `${name} item ${i}`, ['North', 'South', 'East', 'West'][i % 4], (i * 7) % 90 + 1, +(i * 3.25).toFixed(2)]);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name);
}
writeFileSync(resolve(misc, 'book.xlsx'), XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));

// "HTML Report" is what all-tools.mjs waits for.
const paras = Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i + 1}: quarterly figures for the lab, with <b>bold</b> and <i>italic</i> text.</p>`).join('\n');
writeFileSync(resolve(misc, 'page.html'), `<!doctype html><html><head><meta charset="utf-8"><title>HTML Report</title></head><body>
<h1>HTML Report</h1>
<table border="1"><tr><th>Region</th><th>Q1</th><th>Q2</th></tr><tr><td>North</td><td>1,204</td><td>1,390</td></tr><tr><td>South</td><td>980</td><td>1,105</td></tr></table>
<ul><li>First point</li><li>Second point</li></ul>
${paras}
</body></html>`);

// scan_photos.pdf: 6 large photos, about 35 MB.
const doc = await PDFDocument.create();
for (let p = 0; p < 6; p++) {
  const jpg = photo(4000, 3000, 10 + p).toBuffer('image/jpeg', 97);
  const img = await doc.embedJpg(jpg);
  doc.addPage([842, 631.5]).drawImage(img, { x: 0, y: 0, width: 842, height: 631.5 });
}
const bytes = await doc.save();
writeFileSync(resolve(big, 'scan_photos.pdf'), bytes);
console.log(`misc/: photo1.jpg, photo2.png, book.xlsx, page.html · big/scan_photos.pdf ${(bytes.length / 1048576).toFixed(1)} MB`);
