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
import type { WorkerRequest, CropPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

const MM_TO_PT = 72 / 25.4;

export async function cropPdf(payload: CropPayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
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
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Crop applied.');
  return { fileName: `${fileName.replace(/\.[^/.]+$/, '')}_cropped.pdf`, buffer, size: buffer.byteLength, pageCount: pages.length };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<CropPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'CROP_PAGES') return;
    try {
      const result = await cropPdf(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to crop PDF document' } });
    }
  });
}
