/**
 * Compress PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reduces PDF file size by stripping redundant metadata and optimizing internal streams using pdf-lib.
 *
 * `compressPdf` is a plain exported function (no Worker/`self` dependency)
 * so it's directly testable from a Node script — see
 * scripts/test-all-features.ts.
 */

import { PDFDocument } from 'pdf-lib';
import type { WorkerRequest, CompressPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function compressPdf(
  fileBuffer: ArrayBuffer,
  fileName: string,
  level: CompressPayload['level'] = 'recommended',
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for compression.');

  onProgress?.(15, 'Analyzing internal PDF dictionary and stream tree...');
  const pdfDoc = await PDFDocument.load(fileBuffer);
  const pageCount = pdfDoc.getPageCount();

  onProgress?.(40, `Pruning redundant metadata (Compression level: ${level})...`);
  pdfDoc.setTitle('');
  pdfDoc.setAuthor('');
  pdfDoc.setSubject('');
  pdfDoc.setKeywords([]);
  pdfDoc.setProducer('IHatePDF (Client-Side)');
  pdfDoc.setCreator('IHatePDF');

  onProgress?.(70, 'Optimizing stream objects and rebuilding xref table...');
  const compressedBytes = await pdfDoc.save({ useObjectStreams: true, addDefaultPage: false });
  const resultBuffer = compressedBytes.buffer.slice(
    compressedBytes.byteOffset,
    compressedBytes.byteOffset + compressedBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Compression completed.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_compressed.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<CompressPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'COMPRESS_PDF') return;

  try {
    const result = await compressPdf(payload.fileBuffer, payload.fileName, payload.level, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to compress PDF document';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
