/**
 * Centralized initialization for pdfjs-dist.
 *
 * The worker script is bundled via Vite's ?url loader, and the runtime data
 * pdf.js fetches on demand (CMaps for CJK text, metrics/glyphs for the 14
 * standard fonts when a PDF doesn't embed them, WASM decoders for JPEG2000
 * and JBIG2 scans, ICC profiles) is shipped under ./pdfjs/ by
 * scripts/copy-pdfjs-assets.mjs — nothing is fetched from a CDN.
 */

import './polyfills';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import workerUrl from './pdfjs.worker.ts?worker&url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

function assetUrl(dir: string): string {
  const base = typeof document !== 'undefined' ? document.baseURI : self.location.href;
  return new URL(`pdfjs/${dir}/`, base).href;
}

/** Options every `getDocument` call in the app should spread in. */
export const PDFJS_DOCUMENT_OPTIONS = {
  cMapUrl: assetUrl('cmaps'),
  cMapPacked: true,
  standardFontDataUrl: assetUrl('standard_fonts'),
  wasmUrl: assetUrl('wasm'),
  iccUrl: assetUrl('iccs'),
  useSystemFonts: false,
  isEvalSupported: false,
};

/**
 * Feeds pdf.js from a (disk-backed) Blob on demand, so a large PDF is never
 * read into memory whole — only the parts needed for what's rendered.
 */
class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
  constructor(private readonly blob: Blob) {
    super(blob.size, null);
  }

  override requestDataRange(begin: number, end: number) {
    this.blob
      .slice(begin, end)
      .arrayBuffer()
      .then((buf) => this.onDataRange(begin, new Uint8Array(buf)))
      .catch((err) => console.warn('PDF range read failed (document closed?)', err));
  }
}

/** Above this, pdf.js only fetches the ranges it actually needs. */
const FETCH_ON_DEMAND_BYTES = 16 * 1024 * 1024;

export type PdfJsSource = ArrayBuffer | Uint8Array | Blob;

export function openPdfJsDocument(data: PdfJsSource, password?: string) {
  if (data instanceof Blob) {
    return pdfjsLib.getDocument({
      ...PDFJS_DOCUMENT_OPTIONS,
      range: new BlobRangeTransport(data),
      rangeChunkSize: 256 * 1024,
      disableAutoFetch: data.size >= FETCH_ON_DEMAND_BYTES,
      disableStream: true,
      password,
    });
  }
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: bytes, password });
}

export { pdfjsLib };
export default pdfjsLib;
