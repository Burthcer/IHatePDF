/**
 * Font selection for text the app draws into PDFs (editor, watermarks, page
 * numbers, conversions).
 *
 * The 14 standard fonts cost nothing to embed but only cover WinAnsi
 * (Western European). Anything else — Greek, Cyrillic, Central European,
 * symbols — falls back to Liberation Sans (SIL OFL, shipped with pdf.js),
 * embedded and subset via fontkit, so drawing such text never throws.
 */

import { PDFDocument, StandardFonts, type PDFFont } from 'pdf-lib';
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

const LIBERATION_URLS = [
  new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf', import.meta.url),
  new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Bold.ttf', import.meta.url),
  new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-Italic.ttf', import.meta.url),
  new URL('../../node_modules/pdfjs-dist/standard_fonts/LiberationSans-BoldItalic.ttf', import.meta.url),
];

type FileReaderHook = (url: URL) => Promise<Uint8Array>;
declare global {
  var __ihpReadFile: FileReaderHook | undefined;
}

const fontBytesCache = new Map<number, Promise<Uint8Array>>();
function loadLiberation(variant: number): Promise<Uint8Array> {
  let p = fontBytesCache.get(variant);
  if (!p) {
    const url = LIBERATION_URLS[variant];
    p = (async () => {
      if (url.protocol === 'file:' && globalThis.__ihpReadFile) return globalThis.__ihpReadFile(url);
      if (url.protocol === 'file:') {
        // fetch() refuses file:// (the packaged desktop app); XHR still works there.
        return new Promise<Uint8Array>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('GET', url.href);
          xhr.responseType = 'arraybuffer';
          xhr.onload = () => (xhr.response ? resolve(new Uint8Array(xhr.response)) : reject(new Error('Couldn’t load the fallback font.')));
          xhr.onerror = () => reject(new Error('Couldn’t load the fallback font.'));
          xhr.send();
        });
      }
      const res = await fetch(url);
      if (!res.ok) throw new Error(`Couldn't load the fallback font (${res.status}).`);
      return new Uint8Array(await res.arrayBuffer());
    })();
    p.catch(() => fontBytesCache.delete(variant));
    fontBytesCache.set(variant, p);
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

export function standardFont(doc: PDFDocument, req: FontRequest): Promise<PDFFont> {
  const name = STANDARD[req.family][variantIndex(req)];
  return cached(doc, `std:${name}`, () => doc.embedFont(name));
}

export function unicodeFont(doc: PDFDocument, req: FontRequest): Promise<PDFFont> {
  const variant = variantIndex(req);
  return cached(doc, `lib:${variant}`, async () => {
    doc.registerFontkit(fontkit);
    return doc.embedFont(await loadLiberation(variant), { subset: true });
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

/** A font that can draw `text`: the matching standard font if possible, else the Unicode fallback. */
export async function fontForText(doc: PDFDocument, req: FontRequest, text: string): Promise<PDFFont> {
  const std = await standardFont(doc, req);
  const cleaned = text.replace(/[\r\n\t]/g, ' ');
  if (canEncode(std, cleaned)) return std;
  return unicodeFont(doc, req);
}

export interface FontCollection {
  regular: PDFFont;
  bold: PDFFont;
  italic: PDFFont;
  boldItalic: PDFFont;
}

/**
 * Four sans variants able to draw every character in `sampleText`
 * (standard Helvetica when it can, embedded Liberation Sans otherwise).
 */
export async function fontCollection(doc: PDFDocument, sampleText: string): Promise<FontCollection> {
  const regularStd = await standardFont(doc, { family: 'sans', bold: false, italic: false });
  const pick = canEncode(regularStd, sampleText.replace(/[\r\n\t]/g, ' ')) ? standardFont : unicodeFont;
  return {
    regular: await pick(doc, { family: 'sans', bold: false, italic: false }),
    bold: await pick(doc, { family: 'sans', bold: true, italic: false }),
    italic: await pick(doc, { family: 'sans', bold: false, italic: true }),
    boldItalic: await pick(doc, { family: 'sans', bold: true, italic: true }),
  };
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
