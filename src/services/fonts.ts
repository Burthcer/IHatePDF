/**
 * Font selection for text the app draws into PDFs (editor, watermarks, page
 * numbers, forms, conversions).
 *
 * The 14 standard fonts cost nothing to embed but only cover WinAnsi
 * (Western European). Anything else gets an embedded, subset font chosen by
 * script:
 *  - Hindi, Marathi, Sanskrit, Nepali (Devanagari): Noto Sans Devanagari
 *  - Chinese (Simplified and Traditional) and Japanese: Noto Sans SC
 *  - Greek, Cyrillic, Central European, symbols: Liberation Sans (from pdf.js)
 * All SIL OFL (see src/assets/fonts/OFL.txt). Complex scripts are shaped by
 * fontkit — conjuncts, reordered vowel signs, marks — and glyphs that shaping
 * nudges sideways (e.g. ृ under a consonant, the reph of र्क) are placed with
 * TJ adjustments, which pdf-lib on its own would ignore.
 */

// fontkit's Indic shaper was compiled with Babel generators and needs this global.
import 'regenerator-runtime/runtime';
import { PDFDocument, PDFObject, PDFOperator, PDFOperatorNames, StandardFonts, type PDFFont, type PDFHexString } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

export type FontFamily = 'sans' | 'serif' | 'mono';

export interface FontRequest {
  family: FontFamily;
  bold: boolean;
  italic: boolean;
}

const STANDARD: Record<FontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  mono: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

type Face = 'liberation' | 'devanagari' | 'cjk';

/** Per face: regular, bold, italic, bold italic (scripts without italics reuse upright). */
const FACE_URLS: Record<Face, URL[]> = {
  liberation: [
    new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url),
    new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', import.meta.url),
    new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf', import.meta.url),
    new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf', import.meta.url),
  ],
  devanagari: [
    new URL('../assets/fonts/NotoSansDevanagari-Regular.ttf', import.meta.url),
    new URL('../assets/fonts/NotoSansDevanagari-Bold.ttf', import.meta.url),
  ],
  cjk: [new URL('../assets/fonts/NotoSansSC-Regular.ttf', import.meta.url), new URL('../assets/fonts/NotoSansSC-Bold.ttf', import.meta.url)],
};

const DEVANAGARI = /[ऀ-ॿ꣠-ꣿ᳐-᳿]/;
const CJK = /[⺀-⿟　-ヿ㄀-ㄯㆠ-ㇿ㈀-鿿豈-﫿︰-﹏＀-￯]|[\u{20000}-\u{2FA1F}]/u;

/** Scripts whose letters change shape and order in context: only a shaping font can draw them. */
export const needsShaping = (text: string) => DEVANAGARI.test(text);

/** The face for `text`: by the scripts it contains. */
export function faceFor(text: string): Face {
  if (DEVANAGARI.test(text)) return 'devanagari';
  if (CJK.test(text)) return 'cjk';
  return 'liberation';
}

type FileReaderHook = (url: URL) => Promise<Uint8Array>;
declare global {
  var __ihpReadFile: FileReaderHook | undefined;
}

async function readUrl(url: URL): Promise<Uint8Array> {
  if (url.protocol === 'file:' && globalThis.__ihpReadFile) return globalThis.__ihpReadFile(url);
  if (url.protocol === 'file:') {
    // fetch() refuses file:// (the packaged desktop app); XHR still works there.
    return new Promise<Uint8Array>((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url.href);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => (xhr.response ? resolve(new Uint8Array(xhr.response)) : reject(new Error('Couldn’t load a font.')));
      xhr.onerror = () => reject(new Error('Couldn’t load a font.'));
      xhr.send();
    });
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't load a font (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

const fontBytesCache = new Map<string, Promise<Uint8Array>>();
function loadFace(face: Face, variant: number): Promise<Uint8Array> {
  const urls = FACE_URLS[face];
  const url = urls[variant % urls.length];
  let p = fontBytesCache.get(url.href);
  if (!p) {
    p = readUrl(url);
    p.catch(() => fontBytesCache.delete(url.href));
    fontBytesCache.set(url.href, p);
  }
  return p;
}

const docFonts = new WeakMap<PDFDocument, Map<string, Promise<PDFFont>>>();

function variantIndex(req: FontRequest): number {
  return (req.bold ? 1 : 0) + (req.italic ? 2 : 0);
}

function cached(doc: PDFDocument, key: string, make: () => Promise<PDFFont>): Promise<PDFFont> {
  let map = docFonts.get(doc);
  if (!map) {
    map = new Map();
    docFonts.set(doc, map);
  }
  let p = map.get(key);
  if (!p) {
    p = make();
    map.set(key, p);
  }
  return p;
}

// ------------------------------------------------------------ positioned glyphs

/**
 * Shaped glyphs with the sideways nudges shaping asked for, written as a TJ
 * array: [<g1> -74 <g2> 74 <g3>] (numbers in thousandths of the font size).
 */
export class GlyphRun extends PDFObject {
  constructor(private readonly parts: string) {
    super();
  }
  /** The array's contents without brackets, for callers building their own TJ. */
  inner(): string {
    return this.parts;
  }
  override clone(): GlyphRun {
    return new GlyphRun(this.parts);
  }
  override toString(): string {
    return `[${this.parts}]`;
  }
  override sizeInBytes(): number {
    return this.parts.length + 2;
  }
  override copyBytesInto(buffer: Uint8Array, offset: number): number {
    const s = this.toString();
    for (let i = 0; i < s.length; i++) buffer[offset + i] = s.charCodeAt(i);
    return s.length;
  }
}

// drawText() emits Tj; a GlyphRun needs TJ. Patched once, for every page operator.
const baseOperatorOf = PDFOperator.of;
PDFOperator.of = ((name: PDFOperatorNames, args?: unknown[]) =>
  baseOperatorOf(name === PDFOperatorNames.ShowText && args?.[0] instanceof GlyphRun ? PDFOperatorNames.ShowTextAdjusted : name, args as never)) as typeof PDFOperator.of;

interface ShapingFont {
  unitsPerEm: number;
  layout(text: string, features?: unknown): { glyphs: Array<{ advanceWidth: number }>; positions: Array<{ xAdvance: number; xOffset: number }> };
}

const round = (n: number) => Math.round(n * 100) / 100;

/**
 * fontkit shapes a whole string as one script (the first it sees), so in
 * "Page पृष्ठ 12" the Hindi would be left unshaped. Lay out each script run
 * on its own and join the results.
 */
function shapeByScriptRuns(shaper: ShapingFont) {
  const layout = shaper.layout.bind(shaper);
  shaper.layout = (text, features) => {
    const runs = text.match(/[\u0900-\u097F\uA8E0-\uA8FF\u1CD0-\u1CFF\u200C\u200D]+|[^\u0900-\u097F\uA8E0-\uA8FF\u1CD0-\u1CFF]+/g) ?? [text];
    if (runs.length <= 1) return layout(text, features);
    const parts = runs.map((r) => layout(r, features));
    return { glyphs: parts.flatMap((r) => r.glyphs), positions: parts.flatMap((r) => r.positions) };
  };
}

/** Makes `font` (an embedded custom font) write shaping's glyph offsets and advances. */
function positionShapedText(font: PDFFont) {
  const embedder = (font as unknown as { embedder: { font?: ShapingFont; fontFeatures?: unknown } }).embedder;
  const shaper = embedder.font;
  if (!shaper?.layout) return;
  shapeByScriptRuns(shaper);
  const scale = 1000 / shaper.unitsPerEm;
  const encode = font.encodeText.bind(font);
  const widthAt = font.widthOfTextAtSize.bind(font);
  font.encodeText = (text: string) => {
    const hex = encode(text); // registers the glyphs in the subset
    const { glyphs, positions } = shaper.layout(text, embedder.fontFeatures);
    const adjusted = positions.some((p, i) => p.xOffset || p.xAdvance !== glyphs[i].advanceWidth);
    const codes = hex.asString();
    if (!adjusted || codes.length !== glyphs.length * 4) return hex;
    const parts: string[] = [];
    let pending = 0; // thousandths to move before the next glyph
    for (let i = 0; i < glyphs.length; i++) {
      const p = positions[i];
      // TJ numbers move left (thousandths of the size): undo the last glyph's nudge, apply this one's.
      const before = round(pending - p.xOffset * scale);
      if (before) parts.push(String(before));
      parts.push(`<${codes.slice(i * 4, i * 4 + 4)}>`);
      // Undo the offset, and correct the advance to the shaped one.
      pending = p.xOffset * scale + (glyphs[i].advanceWidth - p.xAdvance) * scale;
    }
    return new GlyphRun(parts.join(' ')) as unknown as PDFHexString;
  };
  font.widthOfTextAtSize = (text: string, size: number) => {
    const { positions } = shaper.layout(text, embedder.fontFeatures);
    if (!positions.length) return widthAt(text, size);
    return (positions.reduce((n, p) => n + p.xAdvance, 0) * size) / shaper.unitsPerEm;
  };
}

// ------------------------------------------------------------ subsetting fix

/**
 * fontkit's TrueType subsetter writes the short 'loca' format (offsets / 2)
 * whenever the subset is small, which is only valid if every glyph has an
 * even length. Fonts with odd-length glyphs (Noto Sans SC has many) came out
 * with every later glyph corrupt — Chinese/Japanese characters went missing.
 * Pad odd glyphs by one byte, as font tools normally do.
 */
let subsetterPatched = false;
function patchSubsetter(fontBytes: Uint8Array) {
  if (subsetterPatched) return;
  const probe = (fontkit as unknown as { create(b: Uint8Array): { createSubset(): object } }).create(fontBytes).createSubset();
  const proto = Object.getPrototypeOf(probe) as { _addGlyph?: (gid: number) => number; __ihpPadded?: boolean };
  if (!proto._addGlyph || proto.__ihpPadded) return;
  const addGlyph = proto._addGlyph;
  proto._addGlyph = function (this: { glyf: Uint8Array[]; offset: number }, gid: number) {
    const index = addGlyph.call(this, gid);
    const buf = this.glyf[this.glyf.length - 1];
    if (buf && buf.length % 2) {
      const padded = new (buf.constructor as new (n: number) => Uint8Array)(buf.length + 1);
      padded.set(buf);
      this.glyf[this.glyf.length - 1] = padded;
      this.offset += 1;
    }
    return index;
  };
  proto.__ihpPadded = true;
  subsetterPatched = true;
}

// ------------------------------------------------------------ public API

export function standardFont(doc: PDFDocument, req: FontRequest): Promise<PDFFont> {
  const name = STANDARD[req.family][variantIndex(req)];
  return cached(doc, `std:${name}`, () => doc.embedFont(name));
}

/** An embedded Unicode font for `face` (Liberation Sans by default). */
export function unicodeFont(doc: PDFDocument, req: FontRequest, face: Face = 'liberation'): Promise<PDFFont> {
  const variant = variantIndex(req);
  const urls = FACE_URLS[face];
  return cached(doc, `${face}:${variant % urls.length}`, async () => {
    doc.registerFontkit(fontkit);
    const bytes = await loadFace(face, variant);
    patchSubsetter(bytes);
    const font = await doc.embedFont(bytes, { subset: true });
    if (face !== 'liberation') positionShapedText(font);
    return font;
  });
}

/** True if the standard (WinAnsi) font can encode `text`. */
export function canEncode(font: PDFFont, text: string): boolean {
  try {
    font.encodeText(text);
    return true;
  } catch {
    return false;
  }
}

/** A font that can draw `text`: the matching standard font if possible, else an embedded one for its script. */
export async function fontForText(doc: PDFDocument, req: FontRequest, text: string): Promise<PDFFont> {
  const std = await standardFont(doc, req);
  const cleaned = text.replace(/[\r\n\t]/g, ' ');
  if (canEncode(std, cleaned)) return std;
  return unicodeFont(doc, req, faceFor(cleaned));
}

export interface FontCollection {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

/**
 * Four sans variants able to draw every character in `sampleText`
 * (standard Helvetica when it can, an embedded font for its script otherwise).
 */
export async function fontCollection(doc: PDFDocument, sampleText: string): Promise<FontCollection> {
  const cleaned = sampleText.replace(/[\r\n\t]/g, ' ');
  const regularStd = await standardFont(doc, { family: 'sans', bold: false, italic: false });
  const std = canEncode(regularStd, cleaned);
  const face = faceFor(cleaned);
  const pick = (req: FontRequest) => (std ? standardFont(doc, req) : unicodeFont(doc, req, face));
  return {
    regular: await pick({ family: 'sans', bold: false, italic: false }),
    bold: await pick({ family: 'sans', bold: true, italic: false }),
    italic: await pick({ family: 'sans', bold: false, italic: true }),
    boldItalic: await pick({ family: 'sans', bold: true, italic: true }),
  };
}

/** Splits text into user-perceived characters (a Devanagari conjunct stays whole). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  if (!Seg) return Array.from(text);
  return Array.from(new Seg(undefined, { granularity: 'grapheme' }).segment(text), (s) => s.segment);
}

/** All string values inside a parsed structure (binary data skipped), for font selection. */
export function collectText(value: unknown, out: string[] = [], depth = 0): string {
  if (depth > 40) return out.join(' ');
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectText(v, out, depth + 1));
  else if (value && typeof value === 'object' && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) {
    Object.values(value as Record<string, unknown>).forEach((v) => collectText(v, out, depth + 1));
  }
  return depth === 0 ? [...new Set(out.join(' '))].join('') : '';
}
