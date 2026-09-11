/**
 * Organize PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reorders, duplicates, and deletes pages in a document using pdf-lib.
 *
 * `organizePdfPages` is a plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script — see
 * scripts/test-all-features.ts.
 */

import { PDFDocument } from 'pdf-lib';
import type { WorkerRequest, OrganizePayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function organizePdfPages(
  fileBuffer: ArrayBuffer,
  fileName: string,
  pageOrder: number[],
  deletedPages: number[] = [],
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for organization.');

  onProgress?.(15, 'Loading source PDF document...');
  const sourceDoc = await PDFDocument.load(fileBuffer);
  const totalSourcePages = sourceDoc.getPageCount();

  const deletedSet = new Set(deletedPages);
  const finalOrder = pageOrder.filter((idx) => !deletedSet.has(idx) && idx >= 0 && idx < totalSourcePages);

  if (finalOrder.length === 0) {
    throw new Error('Cannot create an empty PDF. At least one page must remain.');
  }

  onProgress?.(35, 'Allocating new organized document...');
  const organizedDoc = await PDFDocument.create();

  onProgress?.(55, `Copying ${finalOrder.length} pages in new order...`);
  const copiedPages = await organizedDoc.copyPages(sourceDoc, finalOrder);
  for (const page of copiedPages) organizedDoc.addPage(page);

  onProgress?.(85, 'Serializing new document structure...');
  const organizedBytes = await organizedDoc.save();
  const resultBuffer = organizedBytes.buffer.slice(
    organizedBytes.byteOffset,
    organizedBytes.byteOffset + organizedBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Page organization complete.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_organized.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: finalOrder.length,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<OrganizePayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'ORGANIZE_PAGES') return;

  try {
    const result = await organizePdfPages(
      payload.fileBuffer,
      payload.fileName,
      payload.pageOrder,
      payload.deletedPages,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to organize PDF pages';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
