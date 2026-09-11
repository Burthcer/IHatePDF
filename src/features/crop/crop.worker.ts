/**
 * Crop PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Adjusts each page's crop box by a margin (in millimeters) on each side,
 * using pdf-lib's native setCropBox — no rasterization or content-stream
 * surgery needed, the underlying page content is untouched.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  CropPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const MM_TO_PT = 72 / 25.4;

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<CropPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'CROP_PAGES') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, margins, pageIndices } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided for cropping.');
    }

    emitProgress(15, 'Loading PDF document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const targetSet = pageIndices ? new Set(pageIndices) : null;

    emitProgress(40, 'Adjusting page crop boxes...');
    for (let i = 0; i < pages.length; i++) {
      if (targetSet && !targetSet.has(i)) continue;
      const page = pages[i];
      const pageWidth = page.getWidth();
      const pageHeight = page.getHeight();

      const leftPt = Math.max(0, margins.left) * MM_TO_PT;
      const rightPt = Math.max(0, margins.right) * MM_TO_PT;
      const topPt = Math.max(0, margins.top) * MM_TO_PT;
      const bottomPt = Math.max(0, margins.bottom) * MM_TO_PT;

      const newWidth = Math.max(1, pageWidth - leftPt - rightPt);
      const newHeight = Math.max(1, pageHeight - topPt - bottomPt);

      page.setCropBox(leftPt, bottomPt, newWidth, newHeight);
    }

    emitProgress(80, 'Saving cropped document...');
    const croppedBytes = await pdfDoc.save();
    const resultBuffer = croppedBytes.buffer.slice(
      croppedBytes.byteOffset,
      croppedBytes.byteOffset + croppedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Crop applied successfully.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_cropped.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: pages.length,
    };

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };

    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to crop PDF document';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
