// Renders page 1 of each given PDF to one side-by-side PNG (via pdf.js in Chromium, dev server on :5173).
// Usage: node scripts/e2e/snapshot.mjs out.png a.pdf b.pdf ...
import { chromium } from 'playwright-core';
import { relative } from 'node:path';
import { writeFileSync } from 'node:fs';
const [out, ...files] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.goto('http://localhost:5173/');
const data = await page.evaluate(async (urls) => {
  const pdfjs = await import('/node_modules/pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = '/src/services/pdfjs.worker.ts';
  const canvases = [];
  for (const u of urls) {
    const doc = await pdfjs.getDocument({ url: u, standardFontDataUrl: '/node_modules/pdfjs-dist/standard_fonts/', cMapUrl: '/node_modules/pdfjs-dist/cmaps/' }).promise;
    const pg = await doc.getPage(1);
    const vp = pg.getViewport({ scale: 600 / Math.max(pg.view[2], pg.view[3]) });
    const c = document.createElement('canvas');
    c.width = vp.width; c.height = vp.height;
    await pg.render({ canvas: c, viewport: vp }).promise;
    canvases.push(c);
  }
  const W = canvases.reduce((a, c) => a + c.width + 10, 0), H = Math.max(...canvases.map((c) => c.height));
  const m = document.createElement('canvas'); m.width = W; m.height = H;
  const ctx = m.getContext('2d'); ctx.fillStyle = '#888'; ctx.fillRect(0, 0, W, H);
  let x = 0; for (const c of canvases) { ctx.drawImage(c, x, 0); x += c.width + 10; }
  return m.toDataURL('image/png');
}, files.map((f) => '/' + relative(process.cwd(), f)));
writeFileSync(out, Buffer.from(data.split(',')[1], 'base64'));
await browser.close();
