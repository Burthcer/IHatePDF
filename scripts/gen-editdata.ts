// Dumps the encoding tables and the 14 standard fonts' metrics the Edit PDF engine uses into
// crates/ihp-core/src/editdata.json, so the Rust port (editpdf.rs) reads exactly the same numbers.
//   npx tsx scripts/gen-editdata.ts
import { writeFileSync } from 'node:fs';
import { Font } from '@pdf-lib/standard-fonts';
import * as E from '../src/features/editPdf/engine/encodingData';

const names = ['Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique', 'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic', 'Symbol', 'ZapfDingbats'] as const;
const fonts: Record<string, { asc: number | null; desc: number | null; w: Record<string, number> }> = {};
for (const n of names) {
  const f = Font.load(n);
  fonts[n] = { asc: (f.Ascender as number) ?? null, desc: (f.Descender as number) ?? null, w: (f as any).CharWidths };
}
const data = { standard: E.STANDARD_ENCODING, macRoman: E.MAC_ROMAN_ENCODING, winAnsi: E.WIN_ANSI_ENCODING, symbol: E.SYMBOL_ENCODING, zapf: E.ZAPF_DINGBATS_ENCODING, glyphUnicode: E.GLYPH_UNICODE, fonts };
writeFileSync('crates/ihp-core/src/editdata.json', JSON.stringify(data));
console.log('ok', JSON.stringify(data).length);
