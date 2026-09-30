// Realistic student files for the memory tests, written to test-fixtures/scans/ (gitignored):
//   scan_10MB.pdf … scan_500MB.pdf  A4 pages scanned at 300 dpi, stored as JPEG (quality 92,
//                                    ~3.6 MB a page), every page different: paper grain, text
//                                    lines, a stamp and a photo-like figure.
//   journal_10p.pdf, journal_20p.pdf  text journals with headings, paragraphs, a table and figures.
//
// Usage: node scripts/generateScanFixtures.mjs [10 50 150 500 journals]   (default: everything)

import { createCanvas } from '@napi-rs/canvas';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { mkdirSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve('test-fixtures/scans');
const A4 = { w: 595.28, h: 841.89 };
const PX = { w: 2480, h: 3508 }; // A4 at 300 dpi
const TARGET_MB = [10, 50, 150, 500];

// Small deterministic PRNG so every run makes the same files.
function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const WORDS = 'the of and to in is that for on with as was by this be are from at an which or have not has were been their more its can into also than other these two such between some there used where after only first new may most over time any would those both each through while however because under during about'.split(' ');

function scanPage(n) {
  const r = rng(1000 + n);
  const c = createCanvas(PX.w, PX.h);
  const g = c.getContext('2d');
  // Paper: slightly different tint on each page, then grain.
  g.fillStyle = `rgb(${244 + Math.floor(r() * 8)},${240 + Math.floor(r() * 8)},${228 + Math.floor(r() * 12)})`;
  g.fillRect(0, 0, PX.w, PX.h);
  // Text lines, like a scanned handout.
  g.fillStyle = '#1b1b1f';
  g.font = 'bold 64px sans-serif';
  g.fillText(`Unit ${n + 1}: ${WORDS[Math.floor(r() * WORDS.length)]} ${WORDS[Math.floor(r() * WORDS.length)]}`, 220, 320);
  g.font = '40px serif';
  let y = 460;
  const figTop = 1500 + Math.floor(r() * 500);
  while (y < PX.h - 260) {
    if (y > figTop && y < figTop + 900) {
      y = figTop + 960;
      continue;
    }
    let line = '';
    while (line.length < 88) line += WORDS[Math.floor(r() * WORDS.length)] + ' ';
    g.save();
    g.translate(220 + r() * 6, y);
    g.rotate((r() - 0.5) * 0.004); // scans are never quite straight
    g.fillText(line, 0, 0);
    g.restore();
    y += 62;
  }
  // A photo-like figure: gradients and blobs.
  const fx = 300, fw = 1880, fh = 860;
  const grad = g.createLinearGradient(fx, figTop, fx + fw, figTop + fh);
  grad.addColorStop(0, `hsl(${Math.floor(r() * 360)},45%,55%)`);
  grad.addColorStop(1, `hsl(${Math.floor(r() * 360)},50%,35%)`);
  g.fillStyle = grad;
  g.fillRect(fx, figTop, fw, fh);
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `hsla(${Math.floor(r() * 360)},60%,${30 + r() * 50}%,0.45)`;
    g.beginPath();
    g.arc(fx + r() * fw, figTop + r() * fh, 30 + r() * 160, 0, Math.PI * 2);
    g.fill();
  }
  // A rubber stamp.
  g.strokeStyle = 'rgba(160,20,30,0.7)';
  g.lineWidth = 10;
  g.strokeRect(1700, 180, 520, 200);
  g.fillStyle = 'rgba(160,20,30,0.7)';
  g.font = 'bold 72px sans-serif';
  g.fillText(`No. ${1000 + n}`, 1760, 310);
  // Grain: what makes real scans big.
  const img = g.getImageData(0, 0, PX.w, PX.h);
  const d = img.data;
  let seed = (n * 2654435761) >>> 0;
  for (let i = 0; i < d.length; i += 4) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const v = ((seed >>> 16) & 31) - 16;
    d[i] = Math.max(0, Math.min(255, d[i] + v));
    d[i + 1] = Math.max(0, Math.min(255, d[i + 1] + v));
    d[i + 2] = Math.max(0, Math.min(255, d[i + 2] + v));
  }
  g.putImageData(img, 0, 0);
  return c.encodeSync('jpeg', 92);
}

async function makeScan(targetMB) {
  const file = resolve(OUT, `scan_${targetMB}MB.pdf`);
  const doc = await PDFDocument.create();
  let bytes = 0;
  let n = 0;
  while (bytes < targetMB * 1024 * 1024 * 0.97) {
    const jpg = scanPage(n++);
    const img = await doc.embedJpg(jpg);
    doc.addPage([A4.w, A4.h]).drawImage(img, { x: 0, y: 0, width: A4.w, height: A4.h });
    bytes += jpg.length;
    if (n % 10 === 0) process.stdout.write(`  ${targetMB} MB: ${n} pages, ${(bytes / 1048576).toFixed(0)} MB\n`);
  }
  writeFileSync(file, await doc.save({ useObjectStreams: false }));
  console.log(`${file}: ${n} pages, ${(statSync(file).size / 1048576).toFixed(1)} MB (${(bytes / n / 1048576).toFixed(2)} MB a page)`);
}

function figure(seed) {
  const r = rng(seed);
  const c = createCanvas(1200, 700);
  const g = c.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 1200, 700);
  g.strokeStyle = '#333';
  g.lineWidth = 3;
  g.beginPath();
  g.moveTo(80, 620);
  g.lineTo(1150, 620);
  g.moveTo(80, 620);
  g.lineTo(80, 40);
  g.stroke();
  for (let s = 0; s < 3; s++) {
    g.strokeStyle = ['#c0392b', '#2471a3', '#229954'][s];
    g.beginPath();
    let v = 300 + r() * 200;
    for (let x = 80; x <= 1150; x += 15) {
      v = Math.max(60, Math.min(600, v + (r() - 0.5) * 50));
      if (x === 80) g.moveTo(x, v);
      else g.lineTo(x, v);
    }
    g.stroke();
  }
  return c.encodeSync('jpeg', 85);
}

async function makeJournal(pages) {
  const file = resolve(OUT, `journal_${pages}p.pdf`);
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const r = rng(pages);
  const para = (n) => {
    let s = '';
    while (s.length < n) s += WORDS[Math.floor(r() * WORDS.length)] + ' ';
    return s.trim();
  };
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([A4.w, A4.h]);
    let y = A4.h - 72;
    const text = (t, font, size, x = 72, width = A4.w - 144) => {
      const words = t.split(' ');
      let line = '';
      for (const w of words) {
        const next = line ? `${line} ${w}` : w;
        if (font.widthOfTextAtSize(next, size) > width) {
          page.drawText(line, { x, y, size, font });
          y -= size * 1.35;
          line = w;
        } else line = next;
      }
      if (line) page.drawText(line, { x, y, size, font });
      y -= size * 1.35 + 6;
    };
    if (p === 0) {
      text('Journal of Applied Studies, Vol. 12', bold, 18);
      text('A study of ' + para(40), bold, 14);
    }
    text(`${p + 1}. ${para(30)}`, bold, 12);
    text(para(700), regular, 10.5);
    if (p % 2 === 1) {
      const img = await doc.embedJpg(figure(p));
      page.drawImage(img, { x: 72, y: y - 250, width: A4.w - 144, height: 250 });
      y -= 270;
      text(`Figure ${p}: ${para(60)}`, regular, 9);
    } else if (y > 260) {
      // A small table.
      const cols = [72, 200, 320, 440];
      for (let row = 0; row < 6; row++) {
        cols.forEach((x, i) => page.drawText(row === 0 ? ['Group', 'Mean', 'SD', 'n'][i] : i === 0 ? `G${row}` : (r() * 100).toFixed(1), { x, y, size: 10, font: row === 0 ? bold : regular }));
        y -= 16;
      }
      page.drawLine({ start: { x: 72, y: y + 90 }, end: { x: A4.w - 72, y: y + 90 }, thickness: 0.5, color: rgb(0, 0, 0) });
      y -= 12;
    }
    if (y > 150) text(para(400), regular, 10.5);
    page.drawText(`${p + 1}`, { x: A4.w / 2, y: 36, size: 9, font: regular });
  }
  writeFileSync(file, await doc.save());
  console.log(`${file}: ${pages} pages, ${(statSync(file).size / 1048576).toFixed(1)} MB`);
}

mkdirSync(OUT, { recursive: true });
const args = process.argv.slice(2);
const want = (k) => !args.length || args.includes(k);
for (const mb of TARGET_MB) {
  if (!want(String(mb))) continue;
  if (existsSync(resolve(OUT, `scan_${mb}MB.pdf`)) && !args.length) {
    console.log(`scan_${mb}MB.pdf exists, skipped`);
    continue;
  }
  await makeScan(mb);
}
if (want('journals')) {
  await makeJournal(10);
  await makeJournal(20);
}
