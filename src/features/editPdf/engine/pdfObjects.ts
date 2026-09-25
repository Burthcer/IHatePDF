import {
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  decodePDFRawStream,
  type PDFContext,
  type PDFObject,
} from 'pdf-lib';

/** Undoes PNG (10-15) and TIFF (2) predictors, which pdf-lib's decoder leaves in place. */
export function applyPredictor(data: Uint8Array, parms: PDFObject | undefined): Uint8Array {
  if (!(parms instanceof PDFDict)) return data;
  const predictor = dictNumber(parms, 'Predictor') ?? 1;
  if (predictor < 2) return data;
  const colors = dictNumber(parms, 'Colors') ?? 1;
  const bpc = dictNumber(parms, 'BitsPerComponent') ?? 8;
  const columns = dictNumber(parms, 'Columns') ?? 1;
  const bpp = Math.max(1, Math.ceil((colors * bpc) / 8));
  const rowLen = Math.ceil((columns * colors * bpc) / 8);
  if (predictor === 2) {
    if (bpc !== 8) return data;
    const out = data.slice();
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      for (let i = bpp; i < rowLen; i++) out[r + i] = (out[r + i] + out[r + i - bpp]) & 0xff;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  let prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const src = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v = src[i];
      switch (type) {
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
      }
      cur[i] = v & 0xff;
    }
    prev = cur;
  }
  return out;
}

/** Decoded bytes of a stream object, or null if its filters can't be decoded. */
export function streamBytes(obj: PDFObject | undefined): Uint8Array | null {
  if (!obj) return null;
  try {
    if (obj instanceof PDFRawStream) {
      const decoded = decodePDFRawStream(obj).decode();
      const parms = obj.dict.lookup(PDFName.of('DecodeParms'));
      const last = parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms;
      return applyPredictor(decoded, last);
    }
    const s = obj as PDFStream & { getUnencodedContents?: () => Uint8Array };
    if (obj instanceof PDFStream && typeof s.getUnencodedContents === 'function') return s.getUnencodedContents();
  } catch {
    return null;
  }
  return null;
}

export function dictGet(dict: PDFDict | undefined, key: string): PDFObject | undefined {
  if (!dict) return undefined;
  return dict.lookup(PDFName.of(key));
}

export function dictName(dict: PDFDict | undefined, key: string): string | undefined {
  const v = dictGet(dict, key);
  return v instanceof PDFName ? v.decodeText() : undefined;
}

export function dictNumber(dict: PDFDict | undefined, key: string): number | undefined {
  const v = dictGet(dict, key);
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

export function dictDict(dict: PDFDict | undefined, key: string): PDFDict | undefined {
  const v = dictGet(dict, key);
  if (v instanceof PDFDict) return v;
  if (v instanceof PDFStream) return v.dict;
  return undefined;
}

export function numberArray(obj: PDFObject | undefined): number[] | undefined {
  if (!(obj instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < obj.size(); i++) {
    const v = obj.lookup(i);
    out.push(v instanceof PDFNumber ? v.asNumber() : 0);
  }
  return out;
}

export function textOf(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return undefined;
}

/** Stable identity key for an object reached either by reference or directly. */
export function objectKey(raw: PDFObject | undefined, resolved: PDFObject | undefined, fallback: string): string {
  if (raw instanceof PDFRef) return `${raw.objectNumber}_${raw.generationNumber}`;
  if (resolved) {
    const key = directKeys.get(resolved);
    if (key) return key;
    const next = `d${++directKeyCounter}_${fallback}`;
    directKeys.set(resolved, next);
    return next;
  }
  return fallback;
}
const directKeys = new WeakMap<object, string>();
let directKeyCounter = 0;

/** Ensures an object is reachable by reference (registering direct dicts). */
export function asRef(context: PDFContext, raw: PDFObject): PDFRef {
  if (raw instanceof PDFRef) return raw;
  return context.register(raw);
}
