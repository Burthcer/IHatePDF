/**
 * Repair PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reloads with pdf-lib's tolerant parsing (throwOnInvalidObject: false, so
 * malformed objects are skipped instead of aborting the whole parse) and
 * re-serializes cleanly — this is the same core mechanism most "repair"
 * tools use: rebuild the xref/object table from whatever can be recovered,
 * discard what can't.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  RepairPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RepairPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'REPAIR_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName } = payload;
    if (!fileBuffer) throw new Error('No PDF buffer provided.');

    emitProgress(15, 'Tolerantly re-parsing document structure...');
    let pdfDoc: PDFDocument;
    try {
      pdfDoc = await PDFDocument.load(fileBuffer, {
        ignoreEncryption: true,
        throwOnInvalidObject: false,
        updateMetadata: false,
      });
    } catch (loadErr) {
      throw new Error(
        'This PDF is too damaged to repair automatically: ' +
          (loadErr instanceof Error ? loadErr.message : String(loadErr))
      );
    }

    const pageCount = pdfDoc.getPageCount();
    if (pageCount === 0) {
      throw new Error('No readable pages were recovered from this file.');
    }

    emitProgress(60, 'Rebuilding and re-serializing document...');
    const repairedBytes = await pdfDoc.save();
    const resultBuffer = repairedBytes.buffer.slice(
      repairedBytes.byteOffset,
      repairedBytes.byteOffset + repairedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Repair complete.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_repaired.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount,
    };
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to repair PDF document';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
