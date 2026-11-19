// Installed app: PDF to PowerPoint end to end on PDFs PDFium can strip, so Rust does the text boxes, the
// backgrounds, the slide pictures and the .pptx. Fails on any fallback warning or a deck with no text.
// Usage: E2E_CDP=http://127.0.0.1:9222 node scripts/e2e/pdf-to-ppt-native.mjs
import { launch, openTool, upload, runAndDownload } from './harness.mjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { inflateRawSync } from 'node:zlib';

function zipEntries(buf) {
  const out = {};
  let i = buf.length - 22;
  while (i > 0 && buf.readUInt32LE(i) !== 0x06054b50) i--;
  let p = buf.readUInt32LE(i + 16);
  const n = buf.readUInt16LE(i + 10);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const lh = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const raw = buf.subarray(lh, lh + csize);
    out[name] = method === 0 ? raw : inflateRawSync(raw);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

const { browser, page, logs } = await launch();
let bad = 0;
for (const f of ['test-fixtures/test-multi.pdf', 'test-fixtures/quality/q_word.pdf', 'test-fixtures/scans/journal_10p.pdf']) {
  logs.length = 0;
  await openTool(page, 'pdfToPpt');
  await upload(page, resolve(f));
  const r = await runAndDownload(page, 'Convert to PowerPoint', 'deck.pptx');
  const z = zipEntries(readFileSync(r.path));
  const slides = Object.keys(z).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const texts = slides.reduce((n, s) => n + (z[s].toString('utf8').match(/<a:t>/g) ?? []).length, 0);
  const fallbacks = logs.filter((l) => /unavailable|declined/.test(l));
  const ok = slides.length > 0 && texts > 0 && !fallbacks.length;
  if (!ok) bad++;
  console.log(ok ? 'PASS' : 'FAIL', f, `${slides.length} slides, ${texts} text runs`, fallbacks.join(' | '));
}
await browser.close();
process.exit(bad ? 1 : 0);
