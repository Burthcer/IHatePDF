// Renders two PDFs page by page with pdf.js inside Chromium (files served by
// the Vite dev server on :5173) and reports per-page mean pixel difference
// and mean colors. Usage: node renderCompare.mjs a.pdf b.pdf
import { chromium } from 'playwright-core';
import { relative } from 'node:path';

export async function comparePdfs(a, b, scale = 0.25) {
  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  // Same upsert polyfill the app installs (pdf.js 6 needs Map#getOrInsertComputed).
  await page.addInitScript(() => {
    for (const P of [Map.prototype, WeakMap.prototype]) {
      if (!P.getOrInsertComputed) P.getOrInsertComputed = function (k, f) { if (!this.has(k)) this.set(k, f(k)); return this.get(k); };
      if (!P.getOrInsert) P.getOrInsert = function (k, v) { if (!this.has(k)) this.set(k, v); return this.get(k); };
    }
  });
  await page.goto('http://localhost:5173/');
  const res = await page.evaluate(async ({ a, b, scale }) => {
    const pdfjs = await import('/node_modules/pdfjs-dist/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = '/src/services/pdfjs.worker.ts';
    const open = (u) => pdfjs.getDocument({ url: u, wasmUrl: '/node_modules/pdfjs-dist/wasm/', cMapUrl: '/node_modules/pdfjs-dist/cmaps/', standardFontDataUrl: '/node_modules/pdfjs-dist/standard_fonts/' }).promise;
    const render = async (doc, i) => {
      const pg = await doc.getPage(i);
      const vp = pg.getViewport({ scale });
      const c = document.createElement('canvas');
      c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
      const ctx = c.getContext('2d');
      await pg.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
      return ctx.getImageData(0, 0, c.width, c.height);
    };
    const da = await open(a), db = await open(b);
    const out = [];
    for (let i = 1; i <= Math.max(da.numPages, db.numPages); i++) {
      if (i > da.numPages || i > db.numPages) { out.push({ page: i, missing: true }); continue; }
      const A = await render(da, i), B = await render(db, i);
      if (A.width !== B.width || A.height !== B.height) { out.push({ page: i, sizeA: `${A.width}x${A.height}`, sizeB: `${B.width}x${B.height}` }); continue; }
      let d = 0; const ma = [0, 0, 0], mb = [0, 0, 0]; const n = A.data.length / 4;
      for (let k = 0; k < A.data.length; k += 4) for (let c = 0; c < 3; c++) { d += Math.abs(A.data[k + c] - B.data[k + c]); ma[c] += A.data[k + c]; mb[c] += B.data[k + c]; }
      out.push({ page: i, meanDiff: +(d / n / 3).toFixed(2), colorA: ma.map((v) => Math.round(v / n)).join(','), colorB: mb.map((v) => Math.round(v / n)).join(',') });
    }
    return out;
  }, { a: '/' + relative(process.cwd(), a), b: '/' + relative(process.cwd(), b), scale });
  await browser.close();
  return res;
}

if (process.argv[2]) console.table(await comparePdfs(process.argv[2], process.argv[3]));
