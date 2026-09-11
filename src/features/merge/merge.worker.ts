/**
 * Merge PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Combines multiple PDF ArrayBuffers into a single document using pdf-lib.
 * Utilizes zero-copy buffer transfers back to the UI thread.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  MergePayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<MergePayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'MERGE_PDFS') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { files } = payload;
    if (!files || files.length < 2) {
      throw new Error('At least two PDF files are required for merging.');
    }

    emitProgress(5, 'Creating empty target document...');
    const mergedDoc = await PDFDocument.create();

    const totalFiles = files.length;
    let totalPagesMerged = 0;

    for (let i = 0; i < totalFiles; i++) {
      const file = files[i];
      const progressBase = 10 + Math.round((i / totalFiles) * 80);
      emitProgress(progressBase, `Importing pages from "${file.name}" (${i + 1}/${totalFiles})...`);

      const sourceDoc = await PDFDocument.load(file.buffer, {
        ignoreEncryption: false,
      });

      const pageIndices = sourceDoc.getPageIndices();
      const copiedPages = await mergedDoc.copyPages(sourceDoc, pageIndices);

      for (const page of copiedPages) {
        mergedDoc.addPage(page);
      }

      totalPagesMerged += pageIndices.length;
    }

    emitProgress(95, 'Assembling and serializing merged PDF...');
    const mergedBytes = await mergedDoc.save();
    const resultBuffer = mergedBytes.buffer.slice(
      mergedBytes.byteOffset,
      mergedBytes.byteOffset + mergedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Merge completed successfully.');

    const result: ProcessedPdfResult = {
      fileName: 'merged_document.pdf',
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: totalPagesMerged,
    };

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: {
        id,
        success: true,
        data: result,
      },
    };

    // Strict zero-copy buffer transfer
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to merge PDF documents';
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
