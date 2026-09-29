/**
 * Crop PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Sets each page's CropBox. Margins are given as the user sees the page
 * (top = top of the displayed page), so they're mapped onto user-space
 * sides according to /Rotate, and applied relative to the currently
 * visible area (existing CropBox ∩ MediaBox, which needn't start at 0,0).
 */

import { openPdf } from '../../services/pdfLoader';
import { visibleBox, pageRotation } from '../editPdf/engine/geometry';
import type { CropPayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

const MM_TO_PT = 72 / 25.4;

export async function cropPdf(payload: CropPayload, onProgress?: (p: number, s: string) => void, sink?: OutputSink): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, margins, pageIndices } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided for cropping.');

  onProgress?.(15, 'Loading PDF document...');
  const pdfDoc = await openPdf(fileBuffer);
  const pages = pdfDoc.getPages();
  const targets = pageIndices ? new Set(pageIndices) : null;

  onProgress?.(40, 'Adjusting page crop boxes...');
  const t = Math.max(0, margins.top) * MM_TO_PT;
  const r = Math.max(0, margins.right) * MM_TO_PT;
  const b = Math.max(0, margins.bottom) * MM_TO_PT;
  const l = Math.max(0, margins.left) * MM_TO_PT;

  pages.forEach((page, i) => {
    if (targets && !targets.has(i)) return;
    const [x0, y0, x1, y1] = visibleBox(page);
    // displayed side → user-space side
    let left = l, right = r, top = t, bottom = b;
    switch (pageRotation(page)) {
      case 90: [left, top, right, bottom] = [t, r, b, l]; break;
      case 180: [left, top, right, bottom] = [r, b, l, t]; break;
      case 270: [left, top, right, bottom] = [b, l, t, r]; break;
    }
    const width = Math.max(1, x1 - x0 - left - right);
    const height = Math.max(1, y1 - y0 - top - bottom);
    page.setCropBox(x0 + left, y0 + bottom, width, height);
  });

  onProgress?.(80, 'Saving cropped document...');
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: true });
  onProgress?.(100, 'Crop applied.');
  return { fileName: `${fileName.replace(/\.[^/.]+$/, '')}_cropped.pdf`, ...out, pageCount: pages.length };
}

serveTask<CropPayload, ProcessedPdfResult>('CROP_PAGES', (p, ctx) => cropPdf(p, ctx.progress, ctx.sink()), 'Failed to crop PDF document');
