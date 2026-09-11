/**
 * Merge PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Combines multiple PDF ArrayBuffers into a single document using pdf-lib.
 * Utilizes zero-copy buffer transfers back to the UI thread.
 *
 * `mergePdfs` is a plain exported function (no Worker/`self` dependency)
 * so it's directly testable from a Node script — see
 * scripts/test-all-features.ts.
 */

import { PDFDocument } from 'pdf-lib';
import type { WorkerRequest, MergePayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function mergePdfs(
  files: MergePayload['files'],
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  if (!files || files.length < 2) {
    throw new Error('At least two PDF files are required for merging.');
  }

  onProgress?.(5, 'Creating empty target document...');
  const mergedDoc = await PDFDocument.create();

  const totalFiles = files.length;
  let totalPagesMerged = 0;

  for (let i = 0; i < totalFiles; i++) {
    const file = files[i];
    const progressBase = 10 + Math.round((i / totalFiles) * 80);
    onProgress?.(progressBase, `Importing pages from "${file.name}" (${i + 1}/${totalFiles})...`);

    const sourceDoc = await PDFDocument.load(file.buffer, { ignoreEncryption: false });
    const pageIndices = sourceDoc.getPageIndices();
    const copiedPages = await mergedDoc.copyPages(sourceDoc, pageIndices);

    for (const page of copiedPages) {
      mergedDoc.addPage(page);
    }

    totalPagesMerged += pageIndices.length;
  }

  onProgress?.(95, 'Assembling and serializing merged PDF...');
  const mergedBytes = await mergedDoc.save();
  const resultBuffer = mergedBytes.buffer.slice(
    mergedBytes.byteOffset,
    mergedBytes.byteOffset + mergedBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Merge completed successfully.');

  return {
    fileName: 'merged_document.pdf',
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: totalPagesMerged,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<MergePayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'MERGE_PDFS') return;

  try {
    const result = await mergePdfs(payload.files, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to merge PDF documents';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
