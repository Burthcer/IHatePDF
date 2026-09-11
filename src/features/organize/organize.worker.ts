/**
 * Organize PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reorders, duplicates, and deletes pages in a document using pdf-lib.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  OrganizePayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<OrganizePayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'ORGANIZE_PAGES') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, pageOrder, deletedPages = [] } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided for organization.');
    }

    emitProgress(15, 'Loading source PDF document...');
    const sourceDoc = await PDFDocument.load(fileBuffer);
    const totalSourcePages = sourceDoc.getPageCount();

    // Filter out deleted pages and validate index bounds
    const deletedSet = new Set(deletedPages);
    const finalOrder = pageOrder.filter(
      (idx) => !deletedSet.has(idx) && idx >= 0 && idx < totalSourcePages
    );

    if (finalOrder.length === 0) {
      throw new Error('Cannot create an empty PDF. At least one page must remain.');
    }

    emitProgress(35, 'Allocating new organized document...');
    const organizedDoc = await PDFDocument.create();

    emitProgress(55, `Copying ${finalOrder.length} pages in new order...`);
    const copiedPages = await organizedDoc.copyPages(sourceDoc, finalOrder);

    for (const page of copiedPages) {
      organizedDoc.addPage(page);
    }

    emitProgress(85, 'Serializing new document structure...');
    const organizedBytes = await organizedDoc.save();
    const resultBuffer = organizedBytes.buffer.slice(
      organizedBytes.byteOffset,
      organizedBytes.byteOffset + organizedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Page organization complete.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_organized.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: finalOrder.length,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to organize PDF pages';
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
