/**
 * Compress PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reduces PDF file size by stripping redundant metadata and optimizing internal streams using pdf-lib.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  CompressPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<CompressPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'COMPRESS_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, level = 'recommended' } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided for compression.');
    }

    emitProgress(15, 'Analyzing internal PDF dictionary and stream tree...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pageCount = pdfDoc.getPageCount();

    emitProgress(40, `Pruning redundant metadata (Compression level: ${level})...`);
    // Strip document tracking metadata
    pdfDoc.setTitle('');
    pdfDoc.setAuthor('');
    pdfDoc.setSubject('');
    pdfDoc.setKeywords([]);
    pdfDoc.setProducer('IHatePDF (Client-Side)');
    pdfDoc.setCreator('IHatePDF');

    emitProgress(70, 'Optimizing stream objects and rebuilding xref table...');
    // Save with object streams enabled to pack objects into compressed streams
    const compressedBytes = await pdfDoc.save({
      useObjectStreams: true,
      addDefaultPage: false,
    });

    const resultBuffer = compressedBytes.buffer.slice(
      compressedBytes.byteOffset,
      compressedBytes.byteOffset + compressedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Compression completed.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_compressed.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to compress PDF document';
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
