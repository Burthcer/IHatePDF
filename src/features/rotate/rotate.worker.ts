/**
 * Rotate PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Rotates individual pages or entire documents using pdf-lib degrees().
 */

import { PDFDocument, degrees } from 'pdf-lib';
import type {
  WorkerRequest,
  RotatePayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RotatePayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'ROTATE_PAGES') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, rotations = [], globalDegrees = 0 } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided for rotation.');
    }

    emitProgress(15, 'Loading PDF document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const totalPages = pages.length;

    emitProgress(40, 'Applying page orientation adjustments...');

    // Map specific rotations by page index
    const pageRotationMap = new Map<number, number>();
    rotations.forEach((r) => pageRotationMap.set(r.pageIndex, r.degrees));

    for (let i = 0; i < totalPages; i++) {
      const page = pages[i];
      const currentRotation = page.getRotation().angle;
      const specificAngle = pageRotationMap.get(i) || 0;
      const totalDelta = (globalDegrees + specificAngle) % 360;

      if (totalDelta !== 0) {
        const newAngle = (currentRotation + totalDelta + 360) % 360;
        page.setRotation(degrees(newAngle));
      }
    }

    emitProgress(80, 'Saving rotated document...');
    const rotatedBytes = await pdfDoc.save();
    const resultBuffer = rotatedBytes.buffer.slice(
      rotatedBytes.byteOffset,
      rotatedBytes.byteOffset + rotatedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Rotation completed successfully.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_rotated.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: totalPages,
    };

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: {
        id,
        success: true,
        data: result,
      },
    };

    // Zero-copy buffer transfer
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to rotate PDF document';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: {
        id,
        success: false,
        error: errorMsg,
      },
    };
    self.postMessage(responseMsg);
  }
});
