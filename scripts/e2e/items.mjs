import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { readFileSync } from 'node:fs';
const doc = await getDocument({ data: new Uint8Array(readFileSync(process.argv[2])), useSystemFonts: false }).promise;
const p = await doc.getPage(+(process.argv[3] ?? 1));
const tc = await p.getTextContent();
for (const it of tc.items) console.log(JSON.stringify(it.str), it.fontName, it.transform.map((v) => +v.toFixed(2)).join(' '), +it.width.toFixed(2));
