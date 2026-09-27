/**
 * Decodes PDF image XObjects into RGBA pixels so they can be resampled and
 * re-encoded. Covers what real-world PDFs contain: JPEG (gray/RGB/CMYK, incl.
 * Adobe-inverted), JPEG 2000, and lossless (Flate/LZW/RunLength/ASCII) images
 * in Gray, RGB, CMYK, ICC-based, Cal* and Indexed color spaces at 1/2/4/8/16
 * bits, with /Decode arrays and PNG/TIFF predictors. JPEG and JPEG 2000 use
 * pdf.js's own decoders so colors match what viewers show.
 */

import { PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFStream, PDFString, decodePDFRawStream, type PDFObject } from 'pdf-lib';
import '../../services/polyfills';
import { JpegImage, JpxImage } from 'pdfjs-dist/image_decoders/pdf.image_decoders.mjs';
import { applyPredictor, streamBytes } from '../editPdf/engine/pdfObjects';

export interface DecodedImage {
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  /** Rough count of distinct colors (capped) — tells photos from flat artwork. */
  colors: number;
}

type ColorModel =
  | { kind: 'gray' | 'rgb' | 'cmyk'; comps: number }
  | { kind: 'indexed'; comps: 1; base: 'gray' | 'rgb' | 'cmyk'; hival: number; lookup: Uint8Array };

let jpxConfigured = false;
export function configureJpx(wasmUrl: string) {
  if (jpxConfigured) return;
  JpxImage.setOptions({ wasmUrl, useWasm: true, useWorkerFetch: true } as never);
  jpxConfigured = true;
}

function filterNames(dict: PDFDict): string[] {
  const f = dict.lookup(PDFName.of('Filter'));
  if (f instanceof PDFName) return [f.decodeText()];
  if (f instanceof PDFArray) return f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : ''));
  return [];
}

function num(dict: PDFDict, key: string): number | undefined {
  const v = dict.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : undefined;
}

function baseModel(obj: PDFObject | undefined): ColorModel | null {
  if (obj instanceof PDFName) {
    const n = obj.decodeText();
    if (n === 'DeviceGray' || n === 'G' || n === 'CalGray') return { kind: 'gray', comps: 1 };
    if (n === 'DeviceRGB' || n === 'RGB' || n === 'CalRGB') return { kind: 'rgb', comps: 3 };
    if (n === 'DeviceCMYK' || n === 'CMYK') return { kind: 'cmyk', comps: 4 };
    return null;
  }
  if (obj instanceof PDFArray && obj.size() > 0) {
    const fam = obj.lookup(0);
    const name = fam instanceof PDFName ? fam.decodeText() : '';
    if (name === 'ICCBased') {
      const s = obj.lookup(1);
      const n = s instanceof PDFStream ? num(s.dict, 'N') : undefined;
      return n === 1 ? { kind: 'gray', comps: 1 } : n === 4 ? { kind: 'cmyk', comps: 4 } : { kind: 'rgb', comps: 3 };
    }
    if (name === 'CalRGB') return { kind: 'rgb', comps: 3 };
    if (name === 'CalGray') return { kind: 'gray', comps: 1 };
    if (name === 'Indexed' || name === 'I') {
      const base = baseModel(obj.lookup(1));
      const hival = obj.lookup(2);
      const lk = obj.lookup(3);
      if (!base || base.kind === 'indexed' || !(hival instanceof PDFNumber)) return null;
      let lookup: Uint8Array | null = null;
      if (lk instanceof PDFString || lk instanceof PDFHexString) lookup = lk.asBytes();
      else if (lk instanceof PDFStream) lookup = streamBytes(lk);
      if (!lookup) return null;
      return { kind: 'indexed', comps: 1, base: base.kind, hival: hival.asNumber(), lookup };
    }
  }
  return null;
}

/** pdf.js's DeviceCMYK → RGB polynomial, so colors match its rendering. */
function cmykToRgb(c: number, m: number, y: number, k: number, out: Uint8ClampedArray, o: number) {
  out[o] = 255 + c * (-4.387332384609988 * c + 54.48615194189176 * m + 18.82290502165302 * y + 212.25662451639585 * k + -285.2331026137004) + m * (1.7149763477362134 * m - 5.6096736904047315 * y + -17.873870861415444 * k - 5.497006427196366) + y * (-2.5217340131683033 * y - 21.248923337353073 * k + 17.5119270841813) + k * (-21.86122147463605 * k - 189.48180835922747);
  out[o + 1] = 255 + c * (8.841041422036149 * c + 60.118027045597366 * m + 6.871425592049007 * y + 31.159100130055922 * k + -79.2970844816548) + m * (-15.310361306967817 * m + 17.575251261109482 * y + 131.35250912493976 * k - 190.9453302588951) + y * (4.444339102852739 * y + 9.8632861493405 * k - 24.86741582555878) + k * (-20.737325471181034 * k - 187.80453709719578);
  out[o + 2] = 255 + c * (0.8842522430003296 * c + 8.078677503112928 * m + 30.89978309703729 * y - 0.23883238689178934 * k + -14.183576799673286) + m * (10.49593273432072 * m + 63.02378494754052 * y + 50.606957656360734 * k - 112.23884253719248) + y * (0.03296041114873217 * y + 115.60384449646641 * k + -193.58209356861505) + k * (-22.33816807309886 * k - 180.12613974708367);
}

/** Unpacks n-bit samples to 0..1 floats per component, applying /Decode. */
function toRgba(samples: Uint8Array, width: number, height: number, bpc: number, model: ColorModel, decode: number[] | null): Uint8ClampedArray {
  const comps = model.comps;
  const rgba = new Uint8ClampedArray(width * height * 4);
  // Fast paths for the common 8-bit gray/RGB cases without /Decode.
  if (bpc === 8 && !decode && (model.kind === 'rgb' || model.kind === 'gray')) {
    const n = width * height;
    if (model.kind === 'rgb') {
      for (let i = 0, p = 0, o = 0; i < n; i++, p += 3, o += 4) {
        rgba[o] = samples[p];
        rgba[o + 1] = samples[p + 1];
        rgba[o + 2] = samples[p + 2];
        rgba[o + 3] = 255;
      }
    } else {
      for (let i = 0, o = 0; i < n; i++, o += 4) {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = samples[i];
        rgba[o + 3] = 255;
      }
    }
    return rgba;
  }
  const maxVal = (1 << Math.min(bpc, 16)) - 1;
  const rowBits = width * comps * bpc;
  const rowBytes = Math.ceil(rowBits / 8);
  const comp = new Float64Array(comps);
  const tmp = new Uint8ClampedArray(3);
  const dmin = new Float64Array(comps);
  const dmax = new Float64Array(comps);
  for (let c = 0; c < comps; c++) {
    if (decode && decode.length >= 2 * (c + 1)) {
      dmin[c] = decode[2 * c];
      dmax[c] = decode[2 * c + 1];
    } else if (model.kind === 'indexed') {
      dmin[c] = 0;
      dmax[c] = maxVal;
    } else {
      dmin[c] = 0;
      dmax[c] = 1;
    }
  }
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < comps; c++) {
        const sampleIndex = x * comps + c;
        let v: number;
        if (bpc === 8) v = samples[rowStart + sampleIndex];
        else if (bpc === 16) v = (samples[rowStart + sampleIndex * 2] << 8) | samples[rowStart + sampleIndex * 2 + 1];
        else {
          const bit = sampleIndex * bpc;
          const byte = samples[rowStart + (bit >> 3)];
          v = (byte >> (8 - bpc - (bit & 7))) & maxVal;
        }
        comp[c] = dmin[c] + (v / maxVal) * (dmax[c] - dmin[c]);
      }
      const o = (y * width + x) * 4;
      if (model.kind === 'gray') {
        rgba[o] = rgba[o + 1] = rgba[o + 2] = comp[0] * 255;
      } else if (model.kind === 'rgb') {
        rgba[o] = comp[0] * 255;
        rgba[o + 1] = comp[1] * 255;
        rgba[o + 2] = comp[2] * 255;
      } else if (model.kind === 'cmyk') {
        cmykToRgb(comp[0], comp[1], comp[2], comp[3], rgba, o);
      } else {
        const ix = model as Extract<ColorModel, { kind: 'indexed' }>;
        const idx = Math.max(0, Math.min(ix.hival, Math.round(comp[0])));
        const bc = ix.base === 'gray' ? 1 : ix.base === 'rgb' ? 3 : 4;
        const p = idx * bc;
        const lk = ix.lookup;
        if (ix.base === 'gray') rgba[o] = rgba[o + 1] = rgba[o + 2] = lk[p];
        else if (ix.base === 'rgb') {
          rgba[o] = lk[p];
          rgba[o + 1] = lk[p + 1];
          rgba[o + 2] = lk[p + 2];
        } else {
          cmykToRgb(lk[p] / 255, lk[p + 1] / 255, lk[p + 2] / 255, lk[p + 3] / 255, tmp, 0);
          rgba[o] = tmp[0];
          rgba[o + 1] = tmp[1];
          rgba[o + 2] = tmp[2];
        }
      }
      rgba[o + 3] = 255;
    }
  }
  return rgba;
}

function countColors(rgba: Uint8ClampedArray): number {
  const seen = new Set<number>();
  const step = Math.max(4, Math.floor(rgba.length / 4 / 50000) * 4);
  for (let i = 0; i < rgba.length && seen.size < 4097; i += step) seen.add((rgba[i] << 16) | (rgba[i + 1] << 8) | rgba[i + 2]);
  return seen.size;
}

/** Bytes after all filters except a final DCT/JPX one. */
function prefixDecoded(stream: PDFRawStream, filters: string[]): Uint8Array {
  if (filters.length <= 1) return stream.getContents();
  const dict = stream.dict.clone();
  dict.set(PDFName.of('Filter'), PDFArray.withContext(stream.dict.context));
  const arr = dict.lookup(PDFName.of('Filter')) as PDFArray;
  filters.slice(0, -1).forEach((f) => arr.push(PDFName.of(f)));
  dict.delete(PDFName.of('DecodeParms'));
  return decodePDFRawStream(PDFRawStream.of(dict, stream.getContents())).decode();
}

export async function decodePdfImage(stream: PDFRawStream): Promise<DecodedImage | null> {
  const dict = stream.dict;
  const width = num(dict, 'Width') ?? 0;
  const height = num(dict, 'Height') ?? 0;
  if (width <= 0 || height <= 0 || width * height > 120_000_000) return null;
  const filters = filterNames(dict);
  const last = filters[filters.length - 1];
  const decodeObj = dict.lookup(PDFName.of('Decode'));
  const decode = decodeObj instanceof PDFArray ? decodeObj.asArray().map((v) => (v instanceof PDFNumber ? v.asNumber() : 0)) : null;
  const csObj = dict.lookup(PDFName.of('ColorSpace'));
  let model = baseModel(csObj);

  if (last === 'DCTDecode') {
    const bytes = prefixDecoded(stream, filters);
    const jpeg = new JpegImage({});
    jpeg.parse(bytes);
    const comps = jpeg.numComponents;
    const raw = jpeg.getData({ width: jpeg.width, height: jpeg.height, forceRGB: false, isSourcePDF: true } as never) as Uint8ClampedArray;
    if (!model || model.comps !== comps) model = comps === 1 ? { kind: 'gray', comps: 1 } : comps === 4 ? { kind: 'cmyk', comps: 4 } : { kind: 'rgb', comps: 3 };
    // YCC→RGB already happened inside the decoder for 3-component data
    const rgba = toRgba(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), jpeg.width, jpeg.height, 8, model, decode);
    return { width: jpeg.width, height: jpeg.height, rgba, colors: 5000 };
  }

  if (last === 'JPXDecode') {
    const bytes = prefixDecoded(stream, filters);
    const out = (await JpxImage.instance.decode(bytes, { numComponents: 0 })) as Uint8ClampedArray;
    const comps = Math.round(out.length / (width * height));
    let rgba: Uint8ClampedArray;
    if (comps === 4 && model?.kind !== 'cmyk') rgba = out;
    else {
      const m: ColorModel = comps === 1 ? { kind: 'gray', comps: 1 } : comps === 4 ? { kind: 'cmyk', comps: 4 } : { kind: 'rgb', comps: 3 };
      rgba = toRgba(new Uint8Array(out.buffer, out.byteOffset, out.byteLength), width, height, 8, m, null);
    }
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    return { width, height, rgba, colors: 5000 };
  }

  if (filters.some((f) => ['CCITTFaxDecode', 'JBIG2Decode', 'Crypt'].includes(f))) return null;
  if (!model) return null;
  const bpc = num(dict, 'BitsPerComponent') ?? 8;
  if (![1, 2, 4, 8, 16].includes(bpc)) return null;
  let samples: Uint8Array | null;
  try {
    samples = decodePDFRawStream(stream).decode();
    const parms = dict.lookup(PDFName.of('DecodeParms'));
    samples = applyPredictor(samples, parms instanceof PDFArray ? parms.lookup(parms.size() - 1) : parms);
  } catch {
    return null;
  }
  const needed = Math.ceil((width * model.comps * bpc) / 8) * height;
  if (samples.length < needed) return null;
  const rgba = toRgba(samples, width, height, bpc, model, decode);
  return { width, height, rgba, colors: countColors(rgba) };
}
