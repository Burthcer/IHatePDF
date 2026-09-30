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
import { currentLimitMB, memoryState } from './memoryGuard';
import type { PDFDocumentProxy } from 'pdfjs-dist';

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
 * pdf.js decodes JPEGs with the browser's ImageDecoder by default: fast, but
 * its full-size frames (35 MB for a 300 dpi A4 scan) stay in shared memory
 * long after they're drawn — thumbnails of a scanned PDF hold about 1 GB. On
 * a PC with a small memory budget (4 GB of RAM), while Windows is short of
 * memory, or while memory is tight,
 * pdf.js's own decoder is used instead: about 4× slower on scans, but its
 * memory is freed as soon as a page is done.
 */
function documentOptions() {
  // What a job may use right now: smaller on a 4 GB PC, and while Windows is short of memory.
  return { ...PDFJS_DOCUMENT_OPTIONS, isImageDecoderSupported: currentLimitMB() >= 2048 && memoryState().level === 'normal' };
}

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

/**
 * Above this, pdf.js reads the file from disk in ranges, only as needed.
 * Smaller files are simply read whole: faster, and they're small.
 */
const FETCH_ON_DEMAND_BYTES = 16 * 1024 * 1024;

export type PdfJsSource = ArrayBuffer | Uint8Array | Blob;

/** What the app uses of pdf.js' loading task. */
export interface PdfJsTask {
  promise: Promise<PDFDocumentProxy>;
  destroy(): Promise<void>;
}

/**
 * A PDF ends with `startxref … %%EOF`. Without it (a cut-off download), pdf.js
 * rebuilds the file's index by scanning all of it, and reading on demand it
 * restarts that scan for every missing piece: hours for a large file.
 */
async function looksComplete(blob: Blob): Promise<boolean> {
  const tail = await blob.slice(Math.max(0, blob.size - 2048)).text();
  return tail.includes('startxref') && tail.includes('%%EOF');
}

export function openPdfJsDocument(data: PdfJsSource, password?: string): PdfJsTask {
  if (data instanceof Blob && data.size >= FETCH_ON_DEMAND_BYTES) {
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let destroyed = false;
    const promise = looksComplete(data).then((ok) => {
      if (!ok) throw new Error('Invalid PDF structure: the end of the file is missing (startxref).');
      if (destroyed) throw new Error('The document was closed.');
      task = pdfjsLib.getDocument({
        ...documentOptions(),
        range: new BlobRangeTransport(data),
        rangeChunkSize: 256 * 1024,
        disableAutoFetch: true,
        disableStream: true,
        password,
      });
      return task.promise;
    });
    return {
      promise,
      destroy: async () => {
        destroyed = true;
        await task?.destroy();
      },
    };
  }
  if (data instanceof Blob) {
    let task: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let destroyed = false;
    const promise = data.arrayBuffer().then((buf) => {
      if (destroyed) throw new Error('The document was closed.');
      task = pdfjsLib.getDocument({ ...documentOptions(), data: new Uint8Array(buf), password });
      return task.promise;
    });
    return {
      promise,
      destroy: async () => {
        destroyed = true;
        await task?.destroy();
      },
    };
  }
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  const task = pdfjsLib.getDocument({ ...documentOptions(), data: bytes, password });
  return { promise: task.promise, destroy: () => task.destroy() };
}

export { pdfjsLib };
export default pdfjsLib;
