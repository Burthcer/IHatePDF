/**
 * Sign PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps a signature image (drawn, typed, or uploaded — all rasterized to a
 * PNG on the main thread first) onto a chosen page at a chosen position.
 * This is a visual signature stamp, not a cryptographic PKI signature —
 * matching what most PDF tools' free "Sign" feature actually does.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  StampSignaturePayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<StampSignaturePayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'STAMP_SIGNATURE') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, signatureImageBytes, pageIndex, xPt, yPt, widthPt, heightPt } = payload;
    if (!fileBuffer) throw new Error('No PDF buffer provided.');
    if (!signatureImageBytes) throw new Error('No signature image provided.');

    emitProgress(20, 'Loading document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    if (pageIndex < 0 || pageIndex >= pages.length) throw new Error('Invalid page selected.');

    emitProgress(50, 'Embedding signature...');
    const image = await pdfDoc.embedPng(new Uint8Array(signatureImageBytes));
    pages[pageIndex].drawImage(image, { x: xPt, y: yPt, width: widthPt, height: heightPt });

    emitProgress(85, 'Saving PDF...');
    const bytes = await pdfDoc.save();
    const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    emitProgress(100, 'Signed.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_signed.pdf`,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to sign PDF document';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
