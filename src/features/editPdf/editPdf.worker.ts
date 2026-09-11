/**
 * Edit PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Bakes freeform text and image elements (placed in the main-thread editor)
 * directly onto the PDF pages at their given point coordinates.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { WorkerRequest, EditPdfPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

function hexToRgb01(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16) / 255;
  const g = parseInt(clean.substring(2, 4), 16) / 255;
  const b = parseInt(clean.substring(4, 6), 16) / 255;
  return [r, g, b];
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<EditPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'EDIT_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, elements } = payload;
    if (!fileBuffer) throw new Error('No PDF file provided.');

    emitProgress(15, 'Loading document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    emitProgress(35, 'Applying edits...');
    for (let i = 0; i < elements.length; i++) {
      const el = elements[i];
      const page = pages[el.pageIndex];
      if (!page) continue;

      if (el.type === 'text') {
        const [r, g, b] = hexToRgb01(el.color);
        page.drawText(el.text, {
          x: el.xPt,
          y: el.yPt,
          size: el.fontSize,
          font: el.bold ? boldFont : font,
          color: rgb(r, g, b),
        });
      } else {
        const image =
          el.imageType === 'png'
            ? await pdfDoc.embedPng(el.imageBytes)
            : await pdfDoc.embedJpg(el.imageBytes);
        page.drawImage(image, {
          x: el.xPt,
          y: el.yPt,
          width: el.widthPt,
          height: el.heightPt,
        });
      }

      emitProgress(35 + Math.round(((i + 1) / elements.length) * 55), `Applying edit ${i + 1} of ${elements.length}...`);
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
      fileName: `${cleanBaseName}_edited.pdf`,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to edit PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
