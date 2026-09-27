// Copies pdf.js runtime assets (CMaps for CJK text, standard font data for
// non-embedded fonts, WASM image decoders for JPEG2000/JBIG2 scans, ICC
// profiles) into public/pdfjs so they ship with the app and work offline.
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'node_modules/pdfjs-dist');
const dest = resolve(root, 'public/pdfjs');

for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const from = resolve(src, dir);
  if (!existsSync(from)) continue;
  mkdirSync(resolve(dest, dir), { recursive: true });
  cpSync(from, resolve(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
