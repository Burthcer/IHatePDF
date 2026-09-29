/**
 * Compress PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Where PDF bytes actually go, and what's done about each:
 *  - Images (almost always the bulk): every common type is decoded (JPEG
 *    incl. CMYK, JPEG 2000, lossless Gray/RGB/CMYK/ICC/Indexed at 1-16 bit),
 *    downsampled to a target resolution based on how large each image is
 *    actually shown on the page (DPI), and re-encoded — JPEG for photos,
 *    Flate for flat artwork and soft masks. A new version is only kept when
 *    it's smaller.
 *  - Duplicate streams (the same font/image embedded again by merged files):
 *    collapsed to one copy. Unreferenced objects: dropped.
 *  - Uncompressed streams: Flate. Object streams for everything else.
 *  - Page thumbnails and editor-private data; metadata on "extreme".
 *
 * Presets pick a DPI/quality pair. "custom" searches the quality ladder for
 * the best setting that fits a requested file size.
 */

import { PDFArray, PDFBool, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, type PDFDocument, type PDFObject } from 'pdf-lib';
import { deflate } from 'pako';
import { openPdf } from '../../services/pdfLoader';
import { isLazyStream } from '../../services/lazyPdf';
import { interpretPage } from '../editPdf/engine/interpreter';
import { configureJpx, decodePdfImage, type DecodedImage } from './imageCodec';
import type { CompressPayload, ProcessedPdfResult, PdfInput } from '../../types/worker';
import { measurePdf } from '../../services/pdfStreamSave';
import { emitInput, emitPdf, inputSize } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import { memoryBudget, memoryTight } from '../../services/workerMemory';
import type { OutputSink } from '../../services/workerOutput';

type Level = CompressPayload['level'];
interface Setting {
  dpi: number;
  quality: number;
}

const PRESETS: Record<Exclude<Level, 'custom'>, Setting> = {
  low: { dpi: 220, quality: 0.85 },
  recommended: { dpi: 150, quality: 0.72 },
  extreme: { dpi: 96, quality: 0.5 },
};

/** Best → smallest; custom mode picks the first one that fits. */
const COARSE_LADDER: Setting[] = [
  { dpi: 300, quality: 0.9 },
  { dpi: 250, quality: 0.86 },
  { dpi: 220, quality: 0.82 },
  { dpi: 200, quality: 0.78 },
  { dpi: 170, quality: 0.74 },
  { dpi: 150, quality: 0.7 },
  { dpi: 130, quality: 0.64 },
  { dpi: 110, quality: 0.58 },
  { dpi: 96, quality: 0.52 },
  { dpi: 84, quality: 0.46 },
  { dpi: 72, quality: 0.4 },
  { dpi: 60, quality: 0.34 },
  { dpi: 50, quality: 0.28 },
  { dpi: 40, quality: 0.22 },
  { dpi: 30, quality: 0.16 },
];

// Insert a midpoint between every rung so custom targets land close to the
// requested size instead of far under it (binary search keeps passes to ~5).
const LADDER: Setting[] = COARSE_LADDER.flatMap((s, i) => {
  const next = COARSE_LADDER[i + 1];
  if (!next) return [s];
  return [s, { dpi: Math.round((s.dpi + next.dpi) / 2), quality: +((s.quality + next.quality) / 2).toFixed(2) }];
});

type Progress = (progress: number, stage: string) => void;

interface ImageJob {
  ref: PDFRef;
  stream: PDFRawStream;
  originalSize: number;
  width: number;
  height: number;
  isMask: boolean;
  /** Largest size the image is drawn at on any page, in points. */
  shownPt: { w: number; h: number } | null;
}

interface Encoded {
  bytes: Uint8Array;
  width: number;
  height: number;
  format: 'jpeg' | 'flate';
  gray: boolean;
}

const canEncode = () => typeof OffscreenCanvas !== 'undefined';

// ------------------------------------------------------------------ jobs

function collectJobs(doc: PDFDocument): ImageJob[] {
  const context = doc.context;
  const shown = new Map<PDFRef, { w: number; h: number }>();
  for (const page of doc.getPages()) {
    try {
      for (const im of interpretPage(page).images) {
        if (!im.ref) continue;
        const w = Math.hypot(im.ctm[0], im.ctm[1]);
        const h = Math.hypot(im.ctm[2], im.ctm[3]);
        const prev = shown.get(im.ref);
        shown.set(im.ref, { w: Math.max(prev?.w ?? 0, w), h: Math.max(prev?.h ?? 0, h) });
      }
    } catch {
      // unreadable page content — its images fall back to the size cap
    }
  }
  const masks = new Map<PDFRef, PDFRef>(); // smask → owning image
  const jobs: ImageJob[] = [];
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const sub = obj.dict.lookup(PDFName.of('Subtype'));
    if (!(sub instanceof PDFName) || sub.decodeText() !== 'Image') continue;
    const sm = obj.dict.get(PDFName.of('SMask'));
    if (sm instanceof PDFRef) masks.set(sm, ref);
  }
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const d = obj.dict;
    const sub = d.lookup(PDFName.of('Subtype'));
    if (!(sub instanceof PDFName) || sub.decodeText() !== 'Image') continue;
    const im = d.lookup(PDFName.of('ImageMask'));
    if (im instanceof PDFBool && im.asBoolean()) continue; // 1-bit stencils are already tiny
    if (d.lookup(PDFName.of('Mask')) instanceof PDFArray) continue; // color-key masking needs exact pixels
    const width = (d.lookup(PDFName.of('Width')) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    const height = (d.lookup(PDFName.of('Height')) as PDFNumber | undefined)?.asNumber?.() ?? 0;
    if (width < 32 || height < 32) continue;
    const size = obj.getContentsSize();
    if (size < 8_000) continue;
    const owner = masks.get(ref);
    jobs.push({ ref, stream: obj, originalSize: size, width, height, isMask: !!owner, shownPt: shown.get(owner ?? ref) ?? null });
  }
  return jobs.sort((a, b) => b.originalSize - a.originalSize);
}

function targetDims(job: ImageJob, s: Setting): { w: number; h: number } {
  let scale: number;
  if (job.shownPt && job.shownPt.w > 1 && job.shownPt.h > 1) {
    const wantW = (job.shownPt.w / 72) * s.dpi;
    const wantH = (job.shownPt.h / 72) * s.dpi;
    scale = Math.max(wantW / job.width, wantH / job.height);
  } else {
    // Not placed on a page we could read: cap the long side at A4-length × dpi.
    scale = ((11.7 * s.dpi) / Math.max(job.width, job.height));
  }
  scale = Math.min(1, scale);
  return { w: Math.max(16, Math.round(job.width * scale)), h: Math.max(16, Math.round(job.height * scale)) };
}

// ------------------------------------------------------------------ encoding

function resample(img: DecodedImage, w: number, h: number): OffscreenCanvas {
  const src = new OffscreenCanvas(img.width, img.height);
  src.getContext('2d')!.putImageData(new ImageData(img.rgba as unknown as Uint8ClampedArray<ArrayBuffer>, img.width, img.height), 0, 0);
  if (w === img.width && h === img.height) return src;
  // Halve in steps first: a single large downscale aliases.
  let cur: OffscreenCanvas = src;
  let cw = img.width;
  let ch = img.height;
  while (cw / 2 >= w && ch / 2 >= h) {
    const next = new OffscreenCanvas(Math.round(cw / 2), Math.round(ch / 2));
    const ctx = next.getContext('2d')!;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, next.width, next.height);
    cur = next;
    cw = next.width;
    ch = next.height;
  }
  const out = new OffscreenCanvas(w, h);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return out;
}

async function encode(job: ImageJob, img: DecodedImage, s: Setting): Promise<Encoded | null> {
  const { w, h } = targetDims(job, s);
  const downsample = w < img.width || h < img.height;
  const canvas = resample(img, w, h);
  const lossyOk = !job.isMask && (img.colors > 1024 || isLossySource(job));
  if (lossyOk) {
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: s.quality });
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h, format: 'jpeg', gray: false };
  }
  if (!downsample && job.stream.dict.has(PDFName.of('Filter'))) return null; // lossless & same size: nothing to gain
  const px = canvas.getContext('2d')!.getImageData(0, 0, w, h).data;
  const gray = job.isMask || isGrayish(px);
  const raw = new Uint8Array(w * h * (gray ? 1 : 3));
  for (let i = 0, p = 0; i < w * h; i++, p += 4) {
    if (gray) raw[i] = px[p];
    else {
      raw[i * 3] = px[p];
      raw[i * 3 + 1] = px[p + 1];
      raw[i * 3 + 2] = px[p + 2];
    }
  }
  return { bytes: deflate(raw, { level: 9 }), width: w, height: h, format: 'flate', gray };
}

function isLossySource(job: ImageJob): boolean {
  const f = job.stream.dict.lookup(PDFName.of('Filter'));
  const names = f instanceof PDFName ? [f.decodeText()] : f instanceof PDFArray ? f.asArray().map((x) => (x instanceof PDFName ? x.decodeText() : '')) : [];
  return names.includes('DCTDecode') || names.includes('JPXDecode');
}

function isGrayish(px: Uint8ClampedArray): boolean {
  for (let i = 0; i < px.length; i += 4 * 97) if (px[i] !== px[i + 1] || px[i] !== px[i + 2]) return false;
  return true;
}

function applyEncoded(doc: PDFDocument, job: ImageJob, enc: Encoded) {
  const dict = job.stream.dict.clone(doc.context);
  dict.set(PDFName.of('Width'), PDFNumber.of(enc.width));
  dict.set(PDFName.of('Height'), PDFNumber.of(enc.height));
  dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
  dict.set(PDFName.of('Filter'), PDFName.of(enc.format === 'jpeg' ? 'DCTDecode' : 'FlateDecode'));
  dict.set(PDFName.of('ColorSpace'), PDFName.of(enc.gray ? 'DeviceGray' : 'DeviceRGB'));
  for (const k of ['DecodeParms', 'Decode', 'Length', 'DL', 'Intent']) dict.delete(PDFName.of(k));
  // A soft mask still lines up after resampling: masks map onto the image's
  // unit square, not its pixel grid.
  doc.context.assign(job.ref, PDFRawStream.of(dict, enc.bytes));
}

/**
 * Recompressing an image holds its pixels several times over (decoded,
 * canvas, downscaling steps). Images that would need more than a third of the
 * app's memory budget are left as they are rather than risk the PC's memory.
 */
function tooBigToDecode(job: ImageJob): boolean {
  return job.width * job.height * 4 * 3 > memoryBudget() / 3;
}
const skippedHuge = new Set<PDFRef>();

/** Decodes each job once per pass (bounded memory) and encodes it at `s`. */
async function encodeAll(jobs: ImageJob[], s: Setting, report: (i: number) => void): Promise<Map<PDFRef, Encoded>> {
  const out = new Map<PDFRef, Encoded>();
  for (let i = 0; i < jobs.length; i++) {
    report(i);
    const job = jobs[i];
    if (tooBigToDecode(job)) {
      skippedHuge.add(job.ref);
      continue;
    }
    try {
      const img = await decodeCached(job);
      if (!img) continue;
      const enc = await encode(job, img, s);
      if (enc && enc.bytes.length < job.originalSize * 0.97) out.set(job.ref, enc);
    } catch {
      // an image we can't decode stays as it is
    }
  }
  return out;
}

// Keep decoded images around for the custom-size search, which encodes each
// image several times (bounded). Single-pass presets don't cache.
const decodeCache = new Map<PDFRef, DecodedImage | null>();
let cacheBytes = 0;
let cacheEnabled = false;
/** At most 256 MB, and at most an eighth of the memory budget; off when memory is tight. */
const cacheLimit = () => (memoryTight() ? 0 : Math.min(256 * 1024 * 1024, memoryBudget() / 8));
async function decodeCached(job: ImageJob): Promise<DecodedImage | null> {
  if (decodeCache.has(job.ref)) return decodeCache.get(job.ref)!;
  const img = await decodePdfImage(job.stream);
  const size = img ? img.rgba.byteLength : 0;
  if (cacheEnabled && cacheBytes + size <= cacheLimit()) {
    decodeCache.set(job.ref, img);
    cacheBytes += size;
  }
  return img;
}
function clearCache() {
  decodeCache.clear();
  cacheBytes = 0;
  cacheEnabled = false;
}

// ------------------------------------------------------------------ structure

/** Size + dictionary: cheap, and enough to rule out almost every non-duplicate. */
function shapeKey(stream: PDFRawStream): string {
  const entries = stream.dict
    .entries()
    .filter(([k]) => k.decodeText() !== 'Length')
    .map(([k, v]) => `${k.decodeText()}=${v.toString()}`)
    .sort()
    .join('|');
  return `${stream.getContentsSize()}:${entries}`;
}

/** Part of a stream's bytes, read from disk when the stream is still there (never the whole image). */
function streamRange(stream: PDFRawStream, offset: number, length: number): Uint8Array {
  if (isLazyStream(stream)) return stream.source.read(stream.start + offset, length);
  return stream.getContents().subarray(offset, offset + length);
}

const HASH_WINDOW = 64 * 1024;
const COMPARE_CHUNK = 1024 * 1024;

/** Hash of the start, middle and end: tells apart nearly all same-size streams without reading them whole. */
function sampleHash(stream: PDFRawStream): number {
  const size = stream.getContentsSize();
  let h = 0x811c9dc5;
  for (const at of [0, Math.max(0, Math.floor(size / 2) - HASH_WINDOW / 2), Math.max(0, size - HASH_WINDOW)]) {
    const c = streamRange(stream, at, Math.min(HASH_WINDOW, size - at));
    for (let i = 0; i < c.length; i++) h = Math.imul(h ^ c[i], 16777619);
  }
  return h >>> 0;
}

function sameBytes(a: PDFRawStream, b: PDFRawStream): boolean {
  const size = a.getContentsSize();
  if (size !== b.getContentsSize()) return false;
  for (let at = 0; at < size; at += COMPARE_CHUNK) {
    const n = Math.min(COMPARE_CHUNK, size - at);
    const x = streamRange(a, at, n);
    const y = streamRange(b, at, n);
    for (let i = 0; i < n; i++) if (x[i] !== y[i]) return false;
  }
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
  const byShape = new Map<string, PDFRef[]>();
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const key = shapeKey(obj);
    const group = byShape.get(key);
    if (group) group.push(ref);
    else byShape.set(key, [ref]);
  }
  // Only streams that look alike are read and compared.
  const map = new Map<PDFRef, PDFRef>();
  for (const group of byShape.values()) {
    if (group.length < 2) continue;
    const firstByHash = new Map<number, PDFRef>();
    for (const ref of group) {
      const obj = context.lookup(ref) as PDFRawStream;
      const hash = sampleHash(obj);
      const first = firstByHash.get(hash);
      if (!first) {
        firstByHash.set(hash, ref);
        continue;
      }
      if (sameBytes(context.lookup(first) as PDFRawStream, obj)) map.set(ref, first);
    }
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

function losslessCleanup(doc: PDFDocument, level: Level): { deduped: number; removed: number } {
  const context = doc.context;
  for (const page of doc.getPages()) {
    page.node.delete(PDFName.of('Thumb'));
    page.node.delete(PDFName.of('PieceInfo'));
  }
  doc.catalog.delete(PDFName.of('PieceInfo'));
  if (level === 'extreme') doc.catalog.delete(PDFName.of('Metadata'));
  const deduped = dedupeStreams(doc);
  const removed = removeUnreachable(doc);
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && !obj.dict.has(PDFName.of('Filter')) && obj.getContentsSize() > 256) {
      const dict = obj.dict.clone(context);
      dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
      dict.delete(PDFName.of('DecodeParms'));
      context.assign(ref, PDFRawStream.of(dict, deflate(obj.getContents(), { level: 9 })));
    }
  }
  return { deduped, removed };
}

const SAVE_OPTIONS = { useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false };

/** The saved size, computed without building the file. */
const measure = (doc: PDFDocument) => measurePdf(doc, SAVE_OPTIONS);

const fmt = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(2)} MB` : `${Math.round(n / 1024)} KB`);

// ------------------------------------------------------------------ main

export async function compressPdf(
  fileBuffer: PdfInput,
  fileName: string,
  level: Level = 'recommended',
  onProgress?: Progress,
  targetBytes?: number,
  sink?: OutputSink
): Promise<ProcessedPdfResult & { note?: string }> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for compression.');
  const originalSize = inputSize(fileBuffer);
  skippedHuge.clear();
  const base = fileName.replace(/\.[^/.]+$/, '');
  const outName = `${base}_compressed.pdf`;
  const progress = onProgress ?? (() => undefined);

  if (level === 'custom' && (!targetBytes || targetBytes <= 0)) throw new Error('Choose a target size.');
  if (level === 'custom' && targetBytes! >= originalSize) {
    return { fileName: outName, ...(await emitInput(fileBuffer, sink)), note: `The file is already ${fmt(originalSize)} — under the ${fmt(targetBytes!)} target, so it's unchanged.` };
  }

  progress(5, 'Reading document...');
  const doc = await openPdf(fileBuffer);
  const pageCount = doc.getPageCount();
  progress(12, 'Removing duplicates and unused objects...');
  const { deduped, removed } = losslessCleanup(doc, level);
  progress(18, 'Measuring images...');
  const jobs = canEncode() ? collectJobs(doc) : [];
  const imageTotal = jobs.reduce((n, j) => n + j.originalSize, 0);

  let chosen: Map<PDFRef, Encoded> = new Map();
  let note = '';
  try {
    if (level !== 'custom') {
      chosen = await encodeAll(jobs, PRESETS[level], (i) => progress(20 + Math.round((i / Math.max(1, jobs.length)) * 65), `Recompressing image ${i + 1} of ${jobs.length}...`));
    } else {
      // Estimate the non-image weight once, then binary-search the ladder.
      // Only the encodings of the best setting found so far are kept.
      cacheEnabled = true;
      const other = Math.max(0, (await measure(doc)) - imageTotal);
      const target = targetBytes!;
      const estimate = (m: Map<PDFRef, Encoded>) => other + jobs.reduce((n, j) => n + (m.get(j.ref)?.bytes.length ?? j.originalSize), 0);
      let passes = 0;
      const evaluate = (idx: number) => {
        passes++;
        const s = LADDER[idx];
        return encodeAll(jobs, s, (i) => progress(Math.min(88, 20 + passes * 12), `Trying ${s.dpi} dpi / ${Math.round(s.quality * 100)}% quality (image ${i + 1} of ${jobs.length})...`));
      };
      let lo = 0;
      let hi = LADDER.length - 1;
      let best = -1;
      let bestMap: Map<PDFRef, Encoded> | null = null;
      if (other < target) {
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const m = await evaluate(mid);
          if (estimate(m) <= target) {
            best = mid;
            bestMap = m;
            hi = mid - 1;
          } else {
            lo = mid + 1;
          }
        }
      }
      if (best === -1) best = LADDER.length - 1;
      chosen = bestMap ?? (await evaluate(best));
      bestMap = null;
      // The estimate ignores object overhead; step down while the real file is too big.
      for (;;) {
        chosen.forEach((enc, ref) => applyEncoded(doc, jobs.find((j) => j.ref === ref)!, enc));
        const size = await measure(doc);
        if (size <= target || best >= LADDER.length - 1) {
          note =
            size <= target
              ? `Target ${fmt(target)} reached with images at ${LADDER[best].dpi} dpi, ${Math.round(LADDER[best].quality * 100)}% quality.`
              : `Couldn't get down to ${fmt(target)} — this is as small as it goes without destroying legibility (${fmt(size)}). Text, fonts and vector graphics can't be shrunk further.`;
          clearCache();
          return finish(size);
        }
        best++;
        chosen = await evaluate(best);
      }
    }
  } finally {
    clearCache();
  }

  chosen.forEach((enc, ref) => applyEncoded(doc, jobs.find((j) => j.ref === ref)!, enc));
  return finish(await measure(doc));

  async function finish(size: number): Promise<ProcessedPdfResult & { note?: string }> {
    if (size >= originalSize) {
      progress(95, 'Keeping the original...');
      const out = await emitInput(fileBuffer, sink);
      progress(100, 'Done.');
      return {
        fileName: outName,
        ...out,
        pageCount,
        note:
          jobs.length === 0 && !canEncode()
            ? 'Image recompression isn’t available in this browser; the original is returned unchanged.'
            : 'Nothing in this file could be made smaller — it has no oversized images and no duplicate data. The original is returned unchanged.',
      };
    }
    progress(92, 'Writing optimized file...');
    const parts = [
      chosen.size ? `${chosen.size} of ${jobs.length} image${jobs.length === 1 ? '' : 's'} recompressed` : jobs.length ? 'images already optimal' : '',
      skippedHuge.size ? `${skippedHuge.size} very large image${skippedHuge.size === 1 ? '' : 's'} left as ${skippedHuge.size === 1 ? 'is' : 'they are'} to stay within this PC's memory` : '',
      deduped ? `${deduped} duplicate${deduped === 1 ? '' : 's'} merged` : '',
      removed ? `${removed} unused object${removed === 1 ? '' : 's'} dropped` : '',
    ].filter(Boolean);
    chosen = new Map(); // the encodings now live in the document
    const out = await emitPdf(doc, sink, SAVE_OPTIONS);
    progress(100, 'Done.');
    return { fileName: outName, ...out, pageCount, note: [note, parts.join(' · ')].filter(Boolean).join(' ') || undefined };
  }
}

if (typeof self !== 'undefined' && typeof (self as { addEventListener?: unknown }).addEventListener === 'function') {
  try {
    configureJpx(new URL('pdfjs/wasm/', self.location.href.replace(/assets\/[^/]*$|src\/.*$/, '')).href);
  } catch {
    // JPEG 2000 images will simply be left alone
  }
}

serveTask<CompressPayload, ProcessedPdfResult>(
  'COMPRESS_PDF',
  (p, ctx) => compressPdf(p.fileBuffer, p.fileName, p.level, ctx.progress, p.targetBytes, ctx.sink()),
  'Failed to compress PDF document'
);
