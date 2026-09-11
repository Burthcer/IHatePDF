/**
 * JPG/PNG to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Embeds each image as its own page via pdf-lib, scaled to fit within the
 * chosen page size and margins while preserving aspect ratio.
 */

import { PDFDocument } from 'pdf-lib';
import type {
  WorkerRequest,
  ImagesToPdfPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };
const MARGINS = { none: 0, small: 18, big: 54 };

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<ImagesToPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'IMAGES_TO_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { images, orientation, margin, pageSize, fileName } = payload;
    if (!images || images.length === 0) throw new Error('No images provided.');

    emitProgress(10, 'Creating document...');
    const pdfDoc = await PDFDocument.create();
    const marginPt = MARGINS[margin];

    for (let i = 0; i < images.length; i++) {
      const { bytes, type } = images[i];
      const embedded = type === 'jpg' ? await pdfDoc.embedJpg(bytes) : await pdfDoc.embedPng(bytes);
      const imgIsLandscape = embedded.width > embedded.height;

      let baseSize: { width: number; height: number };
      if (pageSize === 'fit') {
        baseSize = { width: embedded.width + marginPt * 2, height: embedded.height + marginPt * 2 };
      } else {
        baseSize = pageSize === 'letter' ? { ...LETTER } : { ...A4 };
        const wantLandscape = orientation === 'landscape' || (orientation === 'auto' && imgIsLandscape);
        if (wantLandscape) baseSize = { width: baseSize.height, height: baseSize.width };
      }

      const page = pdfDoc.addPage([baseSize.width, baseSize.height]);
      const availW = baseSize.width - marginPt * 2;
      const availH = baseSize.height - marginPt * 2;
      const scale = Math.min(availW / embedded.width, availH / embedded.height, 1);
      const drawW = embedded.width * scale;
      const drawH = embedded.height * scale;
      const x = (baseSize.width - drawW) / 2;
      const y = (baseSize.height - drawH) / 2;

      page.drawImage(embedded, { x, y, width: drawW, height: drawH });
      emitProgress(10 + Math.round(((i + 1) / images.length) * 75), `Adding image ${i + 1}/${images.length}...`);
    }

    emitProgress(90, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const resultBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '') || 'images';
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: images.length,
    };
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to build PDF from images';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
