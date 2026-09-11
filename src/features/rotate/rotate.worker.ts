/**
 * Rotate PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Rotates individual pages or entire documents using pdf-lib degrees().
 *
 * `rotatePdfPages` is a plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script — see
 * scripts/test-all-features.ts.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import type { WorkerRequest, RotatePayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function rotatePdfPages(
  fileBuffer: ArrayBuffer,
  fileName: string,
  rotations: RotatePayload['rotations'] = [],
  globalDegrees = 0,
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for rotation.');

  onProgress?.(15, 'Loading PDF document...');
  const pdfDoc = await PDFDocument.load(fileBuffer);
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;

  onProgress?.(40, 'Applying page orientation adjustments...');
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

  onProgress?.(80, 'Saving rotated document...');
  const rotatedBytes = await pdfDoc.save();
  const resultBuffer = rotatedBytes.buffer.slice(
    rotatedBytes.byteOffset,
    rotatedBytes.byteOffset + rotatedBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Rotation completed successfully.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_rotated.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: totalPages,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RotatePayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'ROTATE_PAGES') return;

  try {
    const result = await rotatePdfPages(
      payload.fileBuffer,
      payload.fileName,
      payload.rotations,
      payload.globalDegrees,
      (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      }
    );
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to rotate PDF document';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
