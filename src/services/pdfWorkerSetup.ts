/**
 * Centralized initialization for pdfjs-dist.
 *
 * The worker script is bundled via Vite's ?url loader, and the runtime data
 * pdf.js fetches on demand (CMaps for CJK text, metrics/glyphs for the 14
 * standard fonts when a PDF doesn't embed them, WASM decoders for JPEG2000
 * and JBIG2 scans, ICC profiles) is shipped under ./pdfjs/ by
 * scripts/copy-pdfjs-assets.mjs — nothing is fetched from a CDN.
 */

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

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

export function openPdfJsDocument(data: ArrayBuffer | Uint8Array, password?: string) {
  const bytes = data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
  return pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: bytes, password });
}

export { pdfjsLib };
export default pdfjsLib;
