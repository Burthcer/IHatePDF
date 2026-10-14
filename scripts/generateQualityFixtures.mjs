// Inputs for measuring what Compress does to pictures (principal's "pixelation" point):
//   q_screenshot.pdf  a UI/code screenshot (PNG, small text) placed 16 cm wide, like a screenshot pasted into Word
//   q_photo.pdf       a photo-like JPEG placed 16 cm wide
//   q_scantext.pdf    a scanned text page (JPEG, 300 dpi, black text on white)
//   q_chart.pdf       a chart (flat colours, thin lines, small labels) as PNG
//   q_word.docx       a Word file with the screenshot and the photo between paragraphs (run it through Word to PDF, then Compress)
// The original pictures go to test-fixtures/quality/src/ for scripts/e2e/quality.mjs to compare against.
// Usage: node scripts/generateQualityFixtures.mjs
import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument } from 'pdf-lib';
import { Document, ImageRun, Packer, Paragraph, TextRun } from 'docx';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const out = resolve('test-fixtures/quality');
const src = resolve(out, 'src');
mkdirSync(src, { recursive: true });

function screenshot(w = 1920, h = 1080) {
  const c = createCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#1e1e2e'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#313244'; g.fillRect(0, 0, w, 36); g.fillRect(0, 36, 260, h - 36);
  for (let i = 0; i < 3; i++) { g.fillStyle = ['#f38ba8', '#f9e2af', '#a6e3a1'][i]; g.beginPath(); g.arc(20 + i * 22, 18, 7, 0, 7); g.fill(); }
  g.font = '13px Consolas, monospace';
  const kw = ['const', 'function', 'return', 'import', 'await', 'if'];
  for (let i = 0; i < 38; i++) {
    g.fillStyle = '#6c7086'; g.fillText(String(i + 1).padStart(3, ' '), 280, 70 + i * 22);
    let x = 320;
    for (let k = 0; k < 7; k++) {
      const word = k % 3 === 0 ? kw[(i + k) % kw.length] : `value${(i * 7 + k) % 23}.items[${k}]`;
      g.fillStyle = k % 3 === 0 ? '#cba6f7' : k % 3 === 1 ? '#89b4fa' : '#a6e3a1';
      g.fillText(word, x, 70 + i * 22);
      x += g.measureText(word + ' ').width;
    }
  }
  g.font = '12px Segoe UI, Arial, sans-serif'; g.fillStyle = '#cdd6f4';
  ['src/', '  components/', '  services/', '  hooks/', 'package.json', 'README.md', 'tsconfig.json'].forEach((t, i) => g.fillText(t, 20, 70 + i * 24));
  return c;
}

function photo(w = 3000, h = 2000) {
  const c = createCanvas(w, h), g = c.getContext('2d'), im = g.createImageData(w, h), d = im.data;
  let s = 12345;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const n = (s >>> 24) % 7;
    const sky = 1 - y / h;
    d[i] = 80 + 120 * sky + 40 * Math.sin(x / 90 + y / 140) + n;
    d[i + 1] = 110 + 90 * sky + 50 * Math.cos(x / 70 - y / 110) + n;
    d[i + 2] = 160 + 80 * sky + 30 * Math.sin((x + y) / 180) + n;
    d[i + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  // a few sharp shapes, as in real pictures
  g.fillStyle = '#222'; g.beginPath(); g.moveTo(0, h); g.lineTo(w * 0.3, h * 0.55); g.lineTo(w * 0.6, h); g.fill();
  return c;
}

function scanText(w = 2480, h = 3508) {
  const c = createCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#f4f2ee'; g.fillRect(0, 0, w, h);
  g.fillStyle = '#1a1a1a'; g.font = '44px Times New Roman, serif';
  g.fillText('Practical 7: Linked list operations', 260, 320);
  g.font = '34px Times New Roman, serif';
  const words = 'the program reads a list of integers and then inserts deletes and searches nodes while printing the list after each operation'.split(' ');
  for (let l = 0; l < 60; l++) g.fillText(Array.from({ length: 12 }, (_, k) => words[(l * 5 + k * 3) % words.length]).join(' '), 260, 420 + l * 46);
  return c;
}

function chart(w = 1600, h = 900) {
  const c = createCanvas(w, h), g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.strokeStyle = '#ccc'; g.lineWidth = 1;
  for (let i = 0; i <= 10; i++) { g.beginPath(); g.moveTo(100, 80 + i * 70); g.lineTo(w - 60, 80 + i * 70); g.stroke(); }
  const cols = ['#e63946', '#457b9d', '#2a9d8f', '#f4a261'];
  for (let s = 0; s < 4; s++) {
    g.strokeStyle = cols[s]; g.lineWidth = 3; g.beginPath();
    for (let x = 0; x <= 14; x++) { const px = 100 + x * 100, py = 700 - (60 + s * 40 + 200 * Math.abs(Math.sin(x / 3 + s))); x ? g.lineTo(px, py) : g.moveTo(px, py); }
    g.stroke();
  }
  g.fillStyle = '#222'; g.font = '14px Arial';
  for (let i = 0; i <= 10; i++) g.fillText(String(100 - i * 10), 60, 85 + i * 70);
  for (let x = 0; x <= 14; x++) g.fillText(`W${x + 1}`, 92 + x * 100, 800);
  g.font = '22px Arial'; g.fillText('Weekly lab usage by module', 100, 50);
  return c;
}

async function pdfWith(name, canvas, kind, widthPt, q = 90) {
  const bytes = kind === 'png' ? canvas.toBuffer('image/png') : canvas.toBuffer('image/jpeg', q);
  writeFileSync(resolve(src, name.replace('.pdf', kind === 'png' ? '.png' : '.jpg')), bytes);
  const doc = await PDFDocument.create();
  const img = kind === 'png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const page = doc.addPage([595.28, 841.89]);
  const w = widthPt, h = (w * canvas.height) / canvas.width;
  page.drawImage(img, { x: (595.28 - w) / 2, y: 841.89 - 80 - h, width: w, height: h });
  writeFileSync(resolve(out, name), await doc.save());
  console.log(`${name}: ${(bytes.length / 1024).toFixed(0)} KB image, ${(canvas.width / (w / 72)).toFixed(0)} dpi on the page`);
}

const shot = screenshot(), pic = photo();
await pdfWith('q_screenshot.pdf', shot, 'png', 453.5); // 16 cm
await pdfWith('q_photo.pdf', pic, 'jpg', 453.5, 90);
await pdfWith('q_scantext.pdf', scanText(), 'jpg', 595.28, 85);
await pdfWith('q_chart.pdf', chart(), 'png', 453.5);

const para = (t) => new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: t, size: 24 })] });
const doc = new Document({
  sections: [{ children: [
    para('Practical 3: Observations'), para('The screenshot below shows the program output on the lab machine, with the code that produced it.'),
    new Paragraph({ children: [new ImageRun({ type: 'png', data: shot.toBuffer('image/png'), transformation: { width: 604, height: 340 } })] }),
    para('Figure 1. Program output.'), para('The photograph below shows the circuit used in the second part of the practical.'),
    new Paragraph({ children: [new ImageRun({ type: 'jpg', data: pic.toBuffer('image/jpeg', 90), transformation: { width: 604, height: 403 } })] }),
    para('Figure 2. Circuit setup.'),
  ] }],
});
writeFileSync(resolve(out, 'q_word.docx'), await Packer.toBuffer(doc));
console.log('q_word.docx written');
