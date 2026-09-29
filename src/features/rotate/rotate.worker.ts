/**
 * Rotate PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Rotates individual pages or entire documents using pdf-lib degrees().
 *
 * `rotatePdfPages` is a plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script — see
 * scripts/verify-conversions.ts.
 */

import { degrees } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import type { RotatePayload, ProcessedPdfResult, PdfInput } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function rotatePdfPages(
  fileBuffer: PdfInput,
  fileName: string,
  rotations: RotatePayload['rotations'] = [],
  globalDegrees = 0,
  onProgress?: (progress: number, stage: string) => void,
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for rotation.');

  onProgress?.(15, 'Loading PDF document...');
  const pdfDoc = await openPdf(fileBuffer);
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
  const out = await emitPdf(pdfDoc, sink);

  onProgress?.(100, 'Rotation completed successfully.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_rotated.pdf`,
    ...out,
    pageCount: totalPages,
  };
}

serveTask<RotatePayload, ProcessedPdfResult>(
  'ROTATE_PAGES',
  (p, ctx) => rotatePdfPages(p.fileBuffer, p.fileName, p.rotations, p.globalDegrees, ctx.progress, ctx.sink()),
  'Failed to rotate PDF document'
);
