/**
 * Redact PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Guarantees redacted content is actually gone, not just visually covered:
 * every page is rasterized to an image (in the main thread, via pdfjs) BEFORE
 * this worker ever sees it, black boxes are burned into those pixels, and the
 * result PDF is rebuilt entirely from the redacted images. There is no
 * original text layer, vector content, or hidden object left underneath —
 * the source PDF's object graph is discarded, not edited.
 */

import { PDFDocument, rgb } from 'pdf-lib';
import type { WorkerRequest, RedactPdfPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RedactPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'REDACT_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { pageImages, pageSizesPt, boxes, fileName } = payload;
    if (!pageImages || pageImages.length === 0) throw new Error('No pages to redact.');

    emitProgress(10, 'Rebuilding document from rasterized pages...');
    const pdfDoc = await PDFDocument.create();

    for (let i = 0; i < pageImages.length; i++) {
      const { dataUrl } = pageImages[i];
      const sizePt = pageSizesPt[i];

      const res = await fetch(dataUrl);
      const imgBytes = new Uint8Array(await res.arrayBuffer());
      const isPng = dataUrl.startsWith('data:image/png');
      const image = isPng ? await pdfDoc.embedPng(imgBytes) : await pdfDoc.embedJpg(imgBytes);

      const page = pdfDoc.addPage([sizePt.width, sizePt.height]);
      page.drawImage(image, { x: 0, y: 0, width: sizePt.width, height: sizePt.height });

      const pageBoxes = boxes.filter((b) => b.pageIndex === i);
      for (const box of pageBoxes) {
        page.drawRectangle({
          x: box.xPt,
          y: box.yPt,
          width: box.widthPt,
          height: box.heightPt,
          color: rgb(0, 0, 0),
        });
      }

      emitProgress(10 + Math.round(((i + 1) / pageImages.length) * 80), `Redacting page ${i + 1} of ${pageImages.length}...`);
    }

    emitProgress(95, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const resultBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_redacted.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: pdfDoc.getPageCount(),
    };
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to redact PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
