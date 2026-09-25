/**
 * Compress PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Where PDF bytes actually go, and what's done about each:
 *  - Photos: JPEGs are downsampled to a pixel budget and re-encoded;
 *    losslessly stored RGB/gray photos (Flate) are converted to JPEG.
 *    Only kept when the result is genuinely smaller.
 *  - Duplicate streams (the same font/image embedded again by each merged
 *    file or page): collapsed to one copy.
 *  - Unreferenced objects left behind by incremental saves: dropped.
 *  - Uncompressed streams: Flate-compressed. Object streams for the rest.
 *  - Page thumbnails and editor-private data (/PieceInfo); on "extreme",
 *    XMP metadata too.
 * If nothing helps, the original file is returned rather than a bigger one.
 *
 * `compressPdf` is a plain exported function so it's testable from Node
 * (image recompression is skipped there — it needs OffscreenCanvas).
 */

import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  type PDFContext,
  type PDFDocument,
  type PDFObject,
} from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import { streamBytes } from '../editPdf/engine/pdfObjects';
import type { WorkerRequest, CompressPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

type Level = CompressPayload['level'];

const SETTINGS: Record<Level, { maxDim: number; quality: number; convertLossless: boolean; minGain: number }> = {
  low: { maxDim: 3000, quality: 0.85, convertLossless: false, minGain: 0.1 },
  recommended: { maxDim: 2000, quality: 0.72, convertLossless: true, minGain: 0.08 },
  extreme: { maxDim: 1400, quality: 0.55, convertLossless: true, minGain: 0.03 },
};

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

/** DeviceRGB / DeviceGray / ICCBased(N=1|3) — the spaces a browser-made JPEG can stand in for. */
function simpleColorSpace(dict: PDFDict): 1 | 3 | null {
  const cs = dict.lookup(PDFName.of('ColorSpace'));
  if (cs instanceof PDFName) {
    const n = cs.decodeText();
    return n === 'DeviceRGB' ? 3 : n === 'DeviceGray' ? 1 : null;
  }
  if (cs instanceof PDFArray && cs.size() === 2) {
    const fam = cs.lookup(0);
    const icc = cs.lookup(1);
    if (fam instanceof PDFName && fam.decodeText() === 'ICCBased' && icc instanceof PDFStream) {
      const n = num(icc.dict, 'N');
      return n === 3 ? 3 : n === 1 ? 1 : null;
    }
  }
  return null;
}

const canRecodeImages = () => typeof OffscreenCanvas !== 'undefined' && typeof createImageBitmap !== 'undefined';

async function encodeJpeg(source: ImageBitmap | ImageData, width: number, height: number, quality: number): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  if (source instanceof ImageData) {
    if (source.width === width && source.height === height) ctx.putImageData(source, 0, 0);
    else {
      const tmp = new OffscreenCanvas(source.width, source.height);
      tmp.getContext('2d')!.putImageData(source, 0, 0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(tmp, 0, 0, width, height);
    }
  } else {
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
  }
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return new Uint8Array(await blob.arrayBuffer());
}

async function recompressImage(context: PDFContext, ref: PDFRef, stream: PDFRawStream, level: Level): Promise<boolean> {
  const cfg = SETTINGS[level];
  const dict = stream.dict;
  const imageMask = dict.lookup(PDFName.of('ImageMask'));
  if ((imageMask instanceof PDFBool && imageMask.asBoolean()) || dict.lookup(PDFName.of('Decode')) || dict.lookup(PDFName.of('Mask')) instanceof PDFArray) return false;
  const width = num(dict, 'Width') ?? 0;
  const height = num(dict, 'Height') ?? 0;
  if (width < 64 || height < 64) return false;
  const comps = simpleColorSpace(dict);
  if (!comps) return false;
  const filters = filterNames(dict);
  const original = stream.getContents();
  if (original.length < 20_000) return false;

  const scale = Math.min(1, cfg.maxDim / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale));
  const outH = Math.max(1, Math.round(height * scale));
  let jpeg: Uint8Array | null = null;

  if (filters.length === 1 && filters[0] === 'DCTDecode') {
    const bitmap = await createImageBitmap(new Blob([original as BlobPart], { type: 'image/jpeg' }));
    try {
      jpeg = await encodeJpeg(bitmap, outW, outH, cfg.quality);
    } finally {
      bitmap.close();
    }
  } else if (cfg.convertLossless && filters.every((f) => f === 'FlateDecode' || f === 'LZWDecode') && num(dict, 'BitsPerComponent') === 8 && !dict.lookup(PDFName.of('SMask'))) {
    const raw = streamBytes(stream);
    if (!raw || raw.length < width * height * comps) return false;
    // Skip flat artwork (logos, charts) — JPEG smears it; photos have many colors.
    const rgba = new Uint8ClampedArray(width * height * 4);
    const seen = new Set<number>();
    for (let i = 0, p = 0; i < width * height; i++, p += comps) {
      const r = raw[p];
      const g = comps === 3 ? raw[p + 1] : r;
      const b = comps === 3 ? raw[p + 2] : r;
      rgba[i * 4] = r;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = b;
      rgba[i * 4 + 3] = 255;
      if (seen.size < 4097 && (i & 7) === 0) seen.add((r << 16) | (g << 8) | b);
    }
    if (seen.size < 4096) return false;
    jpeg = await encodeJpeg(new ImageData(rgba, width, height), outW, outH, cfg.quality);
  } else {
    return false;
  }

  if (!jpeg || jpeg.length > original.length * (1 - cfg.minGain)) return false;

  const next = dict.clone(context);
  next.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
  next.delete(PDFName.of('DecodeParms'));
  next.set(PDFName.of('Width'), PDFNumber.of(outW));
  next.set(PDFName.of('Height'), PDFNumber.of(outH));
  next.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  // Browser JPEG encoders always emit RGB.
  if (comps === 1) next.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
  // A soft mask at the old resolution still lines up: masks are mapped onto
  // the image's unit square, not its pixel grid.
  context.assign(ref, PDFRawStream.of(next, jpeg));
  return true;
}

/** Content hash for dedup (FNV-1a over a sample + length; full compare on hit). */
function streamKey(stream: PDFRawStream): string {
  const c = stream.getContents();
  let h = 0x811c9dc5;
  const step = Math.max(1, Math.floor(c.length / 4096));
  for (let i = 0; i < c.length; i += step) h = Math.imul(h ^ c[i], 16777619);
  const entries = stream.dict
    .entries()
    .filter(([k]) => k.decodeText() !== 'Length')
    .map(([k, v]) => `${k.decodeText()}=${v.toString()}`)
    .sort()
    .join('|');
  return `${c.length}:${h >>> 0}:${entries}`;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function remapRefs(obj: PDFObject, map: Map<PDFRef, PDFRef>): void {
  if (obj instanceof PDFDict) {
    for (const [k, v] of obj.entries()) {
      if (v instanceof PDFRef && map.has(v)) obj.set(k, map.get(v)!);
      else remapRefs(v, map);
    }
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) {
      const v = obj.get(i);
      if (v instanceof PDFRef && map.has(v)) obj.set(i, map.get(v)!);
      else remapRefs(v, map);
    }
  } else if (obj instanceof PDFStream) {
    remapRefs(obj.dict, map);
  }
}

function dedupeStreams(doc: PDFDocument): number {
  const context = doc.context;
  const firstByKey = new Map<string, PDFRef>();
  const map = new Map<PDFRef, PDFRef>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const type = obj.dict.lookup(PDFName.of('Type'));
    if (type instanceof PDFName && (type.decodeText() === 'XRef' || type.decodeText() === 'ObjStm')) continue;
    const key = streamKey(obj);
    const first = firstByKey.get(key);
    if (!first) {
      firstByKey.set(key, ref);
      continue;
    }
    const firstObj = context.lookup(first);
    if (firstObj instanceof PDFRawStream && sameBytes(firstObj.getContents(), obj.getContents())) map.set(ref, first);
  }
  if (map.size === 0) return 0;
  for (const [, obj] of context.enumerateIndirectObjects()) remapRefs(obj, map);
  const trailer = context.trailerInfo as Record<string, PDFObject | undefined>;
  for (const key of Object.keys(trailer)) {
    const v = trailer[key];
    if (v instanceof PDFRef && map.has(v)) trailer[key] = map.get(v);
  }
  map.forEach((_, dup) => context.delete(dup));
  return map.size;
}

function removeUnreachable(doc: PDFDocument): number {
  const context = doc.context;
  const reachable = new Set<PDFRef>();
  const stack: PDFObject[] = [];
  const trailer = context.trailerInfo as Record<string, PDFObject | undefined>;
  for (const key of ['Root', 'Info']) if (trailer[key]) stack.push(trailer[key]!);
  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      if (reachable.has(obj)) continue;
      reachable.add(obj);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      obj.values().forEach((v) => stack.push(v));
    } else if (obj instanceof PDFArray) {
      obj.asArray().forEach((v) => stack.push(v));
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref)) {
      context.delete(ref);
      removed++;
    }
  }
  return removed;
}

export async function compressPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  level: Level = 'recommended',
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult & { note?: string }> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for compression.');
  const originalSize = fileBuffer.byteLength;
  const originalCopy = fileBuffer.slice(0);

  onProgress?.(8, 'Reading document...');
  const pdfDoc = await openPdf(fileBuffer);
  const context = pdfDoc.context;
  const pageCount = pdfDoc.getPageCount();

  onProgress?.(15, 'Removing page thumbnails and editor leftovers...');
  for (const page of pdfDoc.getPages()) {
    page.node.delete(PDFName.of('Thumb'));
    page.node.delete(PDFName.of('PieceInfo'));
  }
  pdfDoc.catalog.delete(PDFName.of('PieceInfo'));
  if (level === 'extreme') pdfDoc.catalog.delete(PDFName.of('Metadata'));

  let recoded = 0;
  if (canRecodeImages()) {
    const images: Array<[PDFRef, PDFRawStream]> = [];
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream) {
        const sub = obj.dict.lookup(PDFName.of('Subtype'));
        if (sub instanceof PDFName && sub.decodeText() === 'Image') images.push([ref, obj]);
      }
    }
    for (let i = 0; i < images.length; i++) {
      onProgress?.(20 + Math.round((i / Math.max(1, images.length)) * 50), `Recompressing images (${i + 1}/${images.length})...`);
      try {
        if (await recompressImage(context, images[i][0], images[i][1], level)) recoded++;
      } catch {
        // an image the browser can't decode — leave it as it is
      }
    }
  }

  onProgress?.(75, 'Collapsing duplicate fonts and images...');
  const deduped = dedupeStreams(pdfDoc);
  const removed = removeUnreachable(pdfDoc);

  onProgress?.(82, 'Compressing uncompressed streams...');
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && !obj.dict.has(PDFName.of('Filter')) && obj.getContents().length > 256) {
      const flate = context.flateStream(obj.getContents());
      const dict = obj.dict.clone(context);
      dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      dict.delete(PDFName.of('DecodeParms'));
      context.assign(ref, PDFRawStream.of(dict, flate.getContents()));
    }
  }

  onProgress?.(90, 'Writing optimized file...');
  const bytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  onProgress?.(100, 'Done.');

  if (bytes.byteLength >= originalSize) {
    return {
      fileName: `${cleanBaseName}_compressed.pdf`,
      buffer: originalCopy,
      size: originalSize,
      pageCount,
      note: 'This file is already about as small as it gets — the original is returned unchanged.',
    };
  }
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const parts = [
    recoded ? `${recoded} image${recoded === 1 ? '' : 's'} recompressed` : '',
    deduped ? `${deduped} duplicate${deduped === 1 ? '' : 's'} merged` : '',
    removed ? `${removed} unused object${removed === 1 ? '' : 's'} dropped` : '',
  ].filter(Boolean);
  return {
    fileName: `${cleanBaseName}_compressed.pdf`,
    buffer,
    size: buffer.byteLength,
    pageCount,
    note: parts.join(' · ') || undefined,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<CompressPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'COMPRESS_PDF') return;

  try {
    const result = await compressPdf(payload.fileBuffer, payload.fileName, payload.level, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = { type: 'RESPONSE', payload: { id, success: true, data: result } };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to compress PDF document';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
