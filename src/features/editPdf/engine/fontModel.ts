/**
 * Font model for the content-stream interpreter: turns a PDF font dictionary
 * into what's needed to (a) split shown strings into character codes,
 * (b) know each glyph's advance width, (c) know each glyph's Unicode text,
 * and (d) go the other way — encode new text with the same font when every
 * character is available in it.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFStream, type PDFObject } from 'pdf-lib';
import { Font as StandardFont, type IFontNames } from '@pdf-lib/standard-fonts';
import { lookupCid, parseCMap, splitCodes, type ParsedCMap } from './cmap';
import {
  GLYPH_UNICODE,
  MAC_ROMAN_ENCODING,
  STANDARD_ENCODING,
  SYMBOL_ENCODING,
  WIN_ANSI_ENCODING,
  ZAPF_DINGBATS_ENCODING,
} from './encodingData';
import { dictDict, dictGet, dictName, dictNumber, numberArray, streamBytes } from './pdfObjects';
import { latin1 } from './lexer';
import type { Matrix } from './geometry';

export type FontFamilyClass = 'sans' | 'serif' | 'mono';

export interface CodeSpan {
  code: number;
  start: number;
  len: number;
}

export interface FontModel {
  /** Unique key (object reference or synthetic). */
  key: string;
  /** The raw object as found in /Resources /Font (ref or dict). */
  raw: PDFObject;
  baseFont: string;
  /** Display name without a subset prefix, e.g. "Calibri-Bold". */
  displayName: string;
  subtype: string;
  isType0: boolean;
  isType3: boolean;
  vertical: boolean;
  embedded: boolean;
  subset: boolean;
  fontMatrix: Matrix;
  ascent: number; // text-space units (em fraction)
  descent: number; // negative
  bold: boolean;
  italic: boolean;
  family: FontFamilyClass;
  /** Whether positions/text from this font can be trusted for editing. */
  reliable: boolean;
  decode(bytes: Uint8Array): CodeSpan[];
  /** Horizontal advance of `code` in text-space units (em fraction). */
  width(code: number): number;
  unicode(code: number): string | undefined;
  /** Character codes seen in the page content (subset fonts only guarantee these). */
  observed: Set<number>;
  /** Encodes text with this font, or null if any character is unavailable. */
  encode(text: string): { bytes: Uint8Array; codes: number[] } | null;
}

const STANDARD_ALIASES: Record<string, IFontNames> = {
  arial: 'Helvetica',
  arialmt: 'Helvetica',
  helvetica: 'Helvetica',
  'arial-bold': 'Helvetica-Bold',
  'arial-boldmt': 'Helvetica-Bold',
  'helvetica-bold': 'Helvetica-Bold',
  'arial-italic': 'Helvetica-Oblique',
  'arial-italicmt': 'Helvetica-Oblique',
  'helvetica-oblique': 'Helvetica-Oblique',
  'helvetica-italic': 'Helvetica-Oblique',
  'arial-bolditalic': 'Helvetica-BoldOblique',
  'arial-bolditalicmt': 'Helvetica-BoldOblique',
  'helvetica-boldoblique': 'Helvetica-BoldOblique',
  'helvetica-bolditalic': 'Helvetica-BoldOblique',
  'times-roman': 'Times-Roman',
  timesnewroman: 'Times-Roman',
  timesnewromanps: 'Times-Roman',
  timesnewromanpsmt: 'Times-Roman',
  'times-bold': 'Times-Bold',
  'timesnewroman-bold': 'Times-Bold',
  'timesnewromanps-boldmt': 'Times-Bold',
  'times-italic': 'Times-Italic',
  'timesnewroman-italic': 'Times-Italic',
  'timesnewromanps-italicmt': 'Times-Italic',
  'times-bolditalic': 'Times-BoldItalic',
  'timesnewroman-bolditalic': 'Times-BoldItalic',
  'timesnewromanps-bolditalicmt': 'Times-BoldItalic',
  courier: 'Courier',
  couriernew: 'Courier',
  couriernewpsmt: 'Courier',
  'courier-bold': 'Courier-Bold',
  'couriernew-bold': 'Courier-Bold',
  'couriernewps-boldmt': 'Courier-Bold',
  'courier-oblique': 'Courier-Oblique',
  'courier-italic': 'Courier-Oblique',
  'couriernew-italic': 'Courier-Oblique',
  'courier-boldoblique': 'Courier-BoldOblique',
  'couriernew-bolditalic': 'Courier-BoldOblique',
  symbol: 'Symbol',
  zapfdingbats: 'ZapfDingbats',
};

const standardFontCache = new Map<string, StandardFont>();
function standardMetrics(baseFont: string): StandardFont | undefined {
  const key = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/[ ,]/g, '').toLowerCase();
  const name = STANDARD_ALIASES[key];
  if (!name) return undefined;
  let font = standardFontCache.get(name);
  if (!font) {
    font = StandardFont.load(name);
    standardFontCache.set(name, font);
  }
  return font;
}

export function glyphNameToUnicode(name: string): string | undefined {
  const direct = GLYPH_UNICODE[name];
  if (direct !== undefined) return String.fromCodePoint(direct);
  const base = name.split('.')[0].split('_');
  if (base.length > 1) {
    const parts = base.map(glyphNameToUnicode);
    if (parts.every(Boolean)) return parts.join('');
  }
  const n = base[0];
  if (GLYPH_UNICODE[n] !== undefined) return String.fromCodePoint(GLYPH_UNICODE[n]);
  let m = /^uni([0-9A-Fa-f]{4})+$/.exec(n);
  if (m) {
    let s = '';
    for (let i = 3; i < n.length; i += 4) s += String.fromCharCode(parseInt(n.slice(i, i + 4), 16));
    return s;
  }
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(n);
  if (m) return String.fromCodePoint(parseInt(m[1], 16));
  if (/^[A-Za-z]$/.test(n)) return n;
  if (n === 'ff') return 'ff';
  if (n === 'fi') return 'fi';
  if (n === 'fl') return 'fl';
  if (n === 'ffi') return 'ffi';
  if (n === 'ffl') return 'ffl';
  return undefined;
}

function baseEncodingTable(name: string | undefined): string[] | undefined {
  switch (name) {
    case 'WinAnsiEncoding':
      return WIN_ANSI_ENCODING;
    case 'MacRomanEncoding':
      return MAC_ROMAN_ENCODING;
    case 'StandardEncoding':
      return STANDARD_ENCODING;
    case 'MacExpertEncoding':
      return STANDARD_ENCODING;
    default:
      return undefined;
  }
}

function classify(baseFont: string, descriptor: PDFDict | undefined) {
  const name = baseFont.replace(/^[A-Z]{6}\+/, '');
  const lower = name.toLowerCase();
  const flags = dictNumber(descriptor, 'Flags') ?? 0;
  const weight = dictNumber(descriptor, 'FontWeight') ?? 0;
  const italicAngle = dictNumber(descriptor, 'ItalicAngle') ?? 0;
  const bold =
    /bold|black|heavy|semibold|demibold|extrabold|ultrabold|-bd\b|,bold|w[6-9]\b/.test(lower) ||
    weight >= 600 ||
    (flags & (1 << 18)) !== 0;
  const italic = /italic|oblique|-it\b|,italic|kursiv/.test(lower) || italicAngle !== 0 || (flags & (1 << 6)) !== 0;
  let family: FontFamilyClass = 'sans';
  if (/mono|courier|consol|menlo|fixed|code|typewriter|inconsolata|lucidaconsole/.test(lower) || (flags & 1) !== 0) {
    family = 'mono';
  } else if (
    !/sans|gothic|grotesk|arial|helvetica|verdana|tahoma|segoe|calibri|roboto|inter|lato|open/.test(lower) &&
    (/times|serif|roman|georgia|garamond|cambria|minion|palatino|book|baskerville|caslon|didot|bodoni|merriweather|charter|constantia|century|goudy|mincho|song|ming/.test(
      lower
    ) ||
      (flags & 2) !== 0)
  ) {
    family = 'serif';
  }
  return { displayName: name, bold, italic, family };
}

function readWidthsArray(W: PDFObject | undefined): Map<number, number> {
  const map = new Map<number, number>();
  if (!(W instanceof PDFArray)) return map;
  let i = 0;
  while (i < W.size()) {
    const first = W.lookup(i);
    if (!(first instanceof PDFNumber)) {
      i++;
      continue;
    }
    const next = W.lookup(i + 1);
    if (next instanceof PDFArray) {
      const start = first.asNumber();
      for (let k = 0; k < next.size(); k++) {
        const w = next.lookup(k);
        if (w instanceof PDFNumber) map.set(start + k, w.asNumber());
      }
      i += 2;
    } else if (next instanceof PDFNumber) {
      const last = W.lookup(i + 2);
      const w = last instanceof PDFNumber ? last.asNumber() : 0;
      for (let c = first.asNumber(); c <= next.asNumber() && c - first.asNumber() < 65536; c++) map.set(c, w);
      i += 3;
    } else {
      i++;
    }
  }
  return map;
}

function parseToUnicode(fontDict: PDFDict): ParsedCMap | undefined {
  const obj = fontDict.lookup(PDFName.of('ToUnicode'));
  if (!(obj instanceof PDFStream)) return undefined;
  const bytes = streamBytes(obj);
  if (!bytes) return undefined;
  try {
    return parseCMap(latin1.decode(bytes));
  } catch {
    return undefined;
  }
}

const IDENTITY_CODESPACE = [{ bytes: 2, low: 0, high: 0xffff }];

export function buildFontModel(raw: PDFObject, dict: PDFDict, key: string): FontModel {
  const subtype = dictName(dict, 'Subtype') ?? 'Type1';
  const baseFont = dictName(dict, 'BaseFont') ?? dictName(dict, 'Name') ?? 'Unknown';
  const isType0 = subtype === 'Type0';
  const isType3 = subtype === 'Type3';
  const toUnicode = parseToUnicode(dict);
  const observed = new Set<number>();

  if (isType0) return buildType0(raw, dict, key, baseFont, toUnicode, observed);

  const descriptor = dictDict(dict, 'FontDescriptor');
  const embedded =
    isType3 || !!(dictGet(descriptor, 'FontFile') || dictGet(descriptor, 'FontFile2') || dictGet(descriptor, 'FontFile3'));
  const std = embedded ? undefined : standardMetrics(baseFont);
  const style = classify(baseFont, descriptor);

  // ---- encoding: code -> glyph name
  const names: Array<string | undefined> = new Array(256).fill(undefined);
  const encObj = dict.lookup(PDFName.of('Encoding'));
  let baseTable: string[] | undefined;
  let differences: PDFArray | undefined;
  if (encObj instanceof PDFName) baseTable = baseEncodingTable(encObj.decodeText());
  else if (encObj instanceof PDFDict) {
    baseTable = baseEncodingTable(dictName(encObj, 'BaseEncoding'));
    const d = encObj.lookup(PDFName.of('Differences'));
    if (d instanceof PDFArray) differences = d;
  }
  const lowerName = baseFont.toLowerCase();
  const flags = dictNumber(descriptor, 'Flags') ?? 0;
  const symbolic = (flags & 4) !== 0 && (flags & 32) === 0;
  if (!baseTable) {
    if (/symbol/.test(lowerName) && !embedded) baseTable = SYMBOL_ENCODING;
    else if (/dingbats/.test(lowerName) && !embedded) baseTable = ZAPF_DINGBATS_ENCODING;
    else if (symbolic || isType3) baseTable = undefined;
    else baseTable = subtype === 'TrueType' ? WIN_ANSI_ENCODING : STANDARD_ENCODING;
  }
  if (baseTable) for (let c = 0; c < 256; c++) names[c] = baseTable[c] || undefined;
  const differenceCodes = new Set<number>();
  if (differences) {
    let code = 0;
    for (let i = 0; i < differences.size(); i++) {
      const v = differences.lookup(i);
      if (v instanceof PDFNumber) code = v.asNumber();
      else if (v instanceof PDFName) {
        if (code >= 0 && code < 256) {
          names[code] = v.decodeText();
          differenceCodes.add(code);
        }
        code++;
      }
    }
  }

  // ---- widths
  const firstChar = dictNumber(dict, 'FirstChar') ?? 0;
  const widthsArr = numberArray(dict.lookup(PDFName.of('Widths')));
  const missingWidth = dictNumber(descriptor, 'MissingWidth') ?? 0;
  let fontMatrix: Matrix = [0.001, 0, 0, 0.001, 0, 0];
  if (isType3) {
    const fm = numberArray(dict.lookup(PDFName.of('FontMatrix')));
    if (fm && fm.length === 6) fontMatrix = fm as Matrix;
  }
  const scale = fontMatrix[0] || 0.001;

  const widthOf = (code: number): number => {
    if (widthsArr && code >= firstChar && code < firstChar + widthsArr.length) {
      const w = widthsArr[code - firstChar];
      if (w || !std) return w * scale;
    }
    if (std) {
      const name = names[code];
      const w = name ? std.getWidthOfGlyph(name) : undefined;
      if (typeof w === 'number') return w / 1000;
    }
    return (missingWidth || (widthsArr ? 0 : 500)) * scale;
  };

  // ---- unicode
  const unicodeOf = (code: number): string | undefined => {
    const tu = toUnicode?.unicode.get(code);
    if (tu !== undefined) return tu;
    const name = names[code];
    if (name) {
      const u = glyphNameToUnicode(name);
      if (u !== undefined) return u;
    }
    if (symbolic || !baseTable) {
      // Symbolic fonts without a usable encoding: many producers still map
      // codes 1:1 onto Latin-1, which is the best guess available.
      if (code >= 32 && code < 256) return String.fromCharCode(code);
    }
    return undefined;
  };

  // ---- ascent/descent
  let ascent = (dictNumber(descriptor, 'Ascent') ?? 0) / 1000;
  let descent = (dictNumber(descriptor, 'Descent') ?? 0) / 1000;
  if (isType3) {
    const bbox = numberArray(dict.lookup(PDFName.of('FontBBox')));
    if (bbox && bbox.length === 4) {
      ascent = Math.abs(bbox[3] * fontMatrix[3]);
      descent = -Math.abs(bbox[1] * fontMatrix[3]);
    }
  }
  if (std && !ascent) {
    ascent = ((std.Ascender as number) || 750) / 1000;
    descent = ((std.Descender as number) || -250) / 1000;
  }
  if (!(ascent > 0.3 && ascent < 1.6)) ascent = 0.8;
  if (!(descent < 0 && descent > -0.8)) descent = -0.2;

  // ---- reverse map for re-encoding new text
  let reverse: Map<string, number> | null = null;
  const subset = /^[A-Z]{6}\+/.test(baseFont);
  const buildReverse = () => {
    const map = new Map<string, number>();
    const candidates: number[] = [];
    if (toUnicode) toUnicode.unicode.forEach((_, code) => code < 256 && candidates.push(code));
    else for (let c = 0; c < 256; c++) candidates.push(c);
    for (const code of candidates) {
      if (subset && !observed.has(code)) continue;
      if (!toUnicode && !subset) {
        const inRange = widthsArr ? code >= firstChar && code < firstChar + widthsArr.length && widthsArr[code - firstChar] > 0 : !!std;
        if (!inRange && !differenceCodes.has(code)) continue;
      }
      const u = unicodeOf(code);
      if (u && u.length === 1 && !map.has(u)) map.set(u, code);
    }
    // The space glyph is so universally present that producers routinely
    // leave it out of subsets' observed codes only because they position
    // words with TJ offsets instead; allow it when the font maps it at all.
    if (!map.has(' ')) {
      for (let c = 0; c < 256; c++) {
        if (unicodeOf(c) === ' ' && (!subset || observed.has(c))) {
          map.set(' ', c);
          break;
        }
      }
    }
    return map;
  };

  return {
    key,
    raw,
    baseFont,
    displayName: style.displayName,
    subtype,
    isType0: false,
    isType3,
    vertical: false,
    embedded,
    subset,
    fontMatrix,
    ascent,
    descent,
    bold: style.bold,
    italic: style.italic,
    family: style.family,
    reliable: true,
    decode: (bytes) => {
      const out: CodeSpan[] = new Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) out[i] = { code: bytes[i], start: i, len: 1 };
      return out;
    },
    width: widthOf,
    unicode: unicodeOf,
    observed,
    encode(text) {
      reverse ??= buildReverse();
      const codes: number[] = [];
      for (const ch of text) {
        const code = reverse.get(ch) ?? (ch === ' ' ? reverse.get(' ') : undefined);
        if (code === undefined) return null;
        codes.push(code);
      }
      return { bytes: new Uint8Array(codes), codes };
    },
  };
}

function buildType0(
  raw: PDFObject,
  dict: PDFDict,
  key: string,
  baseFont: string,
  toUnicode: ParsedCMap | undefined,
  observed: Set<number>
): FontModel {
  const descendants = dict.lookup(PDFName.of('DescendantFonts'));
  const cidFont = descendants instanceof PDFArray ? descendants.lookup(0) : undefined;
  const cidDict = cidFont instanceof PDFDict ? cidFont : undefined;
  const descriptor = dictDict(cidDict, 'FontDescriptor');
  const embedded = !!(dictGet(descriptor, 'FontFile') || dictGet(descriptor, 'FontFile2') || dictGet(descriptor, 'FontFile3'));
  const style = classify(baseFont, descriptor);

  const encObj = dict.lookup(PDFName.of('Encoding'));
  let codespaces = IDENTITY_CODESPACE;
  let encCMap: ParsedCMap | undefined;
  let vertical = false;
  let reliable = true;
  if (encObj instanceof PDFName) {
    const name = encObj.decodeText();
    vertical = name.endsWith('-V');
    if (name !== 'Identity-H' && name !== 'Identity-V') {
      // Predefined CJK CMaps (e.g. UniJIS-UCS2-H) need external CMap data
      // this engine doesn't carry; decode as 2-byte and don't offer editing.
      reliable = false;
    }
  } else if (encObj instanceof PDFStream) {
    const bytes = streamBytes(encObj);
    if (bytes) {
      encCMap = parseCMap(latin1.decode(bytes));
      if (encCMap.codespaces.length > 0) codespaces = encCMap.codespaces;
      vertical = encCMap.vertical;
      if (encCMap.useCMap && !/^Identity/.test(encCMap.useCMap)) reliable = false;
    }
  }
  if (vertical) reliable = false;

  const widths = readWidthsArray(cidDict?.lookup(PDFName.of('W')));
  const dw = dictNumber(cidDict, 'DW') ?? 1000;
  const cidOf = (code: number) => (encCMap ? lookupCid(encCMap, code) ?? code : code);
  const codeLen = codespaces.length > 0 ? Math.min(...codespaces.map((c) => c.bytes)) : 2;

  let ascent = (dictNumber(descriptor, 'Ascent') ?? 0) / 1000;
  let descent = (dictNumber(descriptor, 'Descent') ?? 0) / 1000;
  if (!(ascent > 0.3 && ascent < 1.6)) ascent = 0.88;
  if (!(descent < 0 && descent > -0.8)) descent = -0.12;

  const subset = /^[A-Z]{6}\+/.test(baseFont);
  let reverse: Map<string, number> | null = null;
  const buildReverse = () => {
    const map = new Map<string, number>();
    toUnicode?.unicode.forEach((u, code) => {
      if (subset && !observed.has(code)) return;
      if (u.length >= 1 && [...u].length === 1 && !map.has(u)) map.set(u, code);
    });
    return map;
  };
  const allCodespacesSameWidth = codespaces.every((c) => c.bytes === codespaces[0].bytes);

  return {
    key,
    raw,
    baseFont,
    displayName: style.displayName,
    subtype: 'Type0',
    isType0: true,
    isType3: false,
    vertical,
    embedded,
    subset,
    fontMatrix: [0.001, 0, 0, 0.001, 0, 0],
    ascent,
    descent,
    bold: style.bold,
    italic: style.italic,
    family: style.family,
    reliable,
    decode: (bytes) => splitCodes(bytes, codespaces, codeLen),
    width: (code) => (widths.get(cidOf(code)) ?? dw) / 1000,
    unicode: (code) => toUnicode?.unicode.get(code),
    observed,
    encode(text) {
      if (!toUnicode || !allCodespacesSameWidth) return null;
      reverse ??= buildReverse();
      const width = codespaces[0].bytes;
      const codes: number[] = [];
      for (const ch of text) {
        const code = reverse.get(ch) ?? (ch === ' ' ? reverse.get(' ') : undefined);
        if (code === undefined) return null;
        codes.push(code);
      }
      const bytes = new Uint8Array(codes.length * width);
      codes.forEach((code, i) => {
        for (let k = 0; k < width; k++) bytes[i * width + k] = (code >> (8 * (width - 1 - k))) & 0xff;
      });
      return { bytes, codes };
    },
  };
}
