/**
 * Centralized initialization for pdfjs-dist
 * IHatePDF - 100% Client-Side Architecture
 *
 * Configures the PDF.js GlobalWorkerOptions to use local bundled assets
 * via Vite's ?url asset loader. Never loads external unpinned CDNs.
 */

import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export { pdfjsLib };
export default pdfjsLib;
