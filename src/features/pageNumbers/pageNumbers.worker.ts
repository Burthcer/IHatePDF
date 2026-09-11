/**
 * Page Numbers Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps a page-number label onto every page in a range, using pdf-lib's
 * standard Helvetica font (no font embedding needed for plain digits/text).
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { hexToRgb01, computeAnchor, toRoman } from '../../services/pdfStampPosition';
import type {
  WorkerRequest,
  PageNumbersPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const MM_TO_PT = 72 / 25.4;

function formatLabel(format: PageNumbersPayload['format'], n: number, total: number): string {
  if (format === 'roman') return toRoman(n);
  if (format === 'n_of_total') return `Page ${n} of ${total}`;
  return String(n);
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PageNumbersPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'ADD_PAGE_NUMBERS') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, format, position, fontSize, color, marginMm, startPage, endPage, startingNumber } =
      payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided.');
    }

    emitProgress(10, 'Loading PDF document...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pages = pdfDoc.getPages();
    const totalPages = pages.length;
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const { r, g, b } = hexToRgb01(color);
    const marginPt = marginMm * MM_TO_PT;

    const from = Math.max(1, startPage) - 1;
    const to = Math.min(totalPages, endPage || totalPages) - 1;

    emitProgress(35, 'Stamping page numbers...');
    let counter = startingNumber;
    for (let i = from; i <= to; i++) {
      const page = pages[i];
      const label = formatLabel(format, counter, totalPages);
      counter++;

      const textWidth = font.widthOfTextAtSize(label, fontSize);
      const textHeight = font.heightAtSize(fontSize);
      const { x, y } = computeAnchor(
        page.getWidth(),
        page.getHeight(),
        textWidth,
        textHeight,
        position,
        marginPt
      );

      page.drawText(label, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(r, g, b),
      });

      if (to > from) {
        emitProgress(35 + Math.round(((i - from) / (to - from)) * 50), `Stamping page ${i + 1}...`);
      }
    }

    emitProgress(90, 'Saving document...');
    const outBytes = await pdfDoc.save();
    const resultBuffer = outBytes.buffer.slice(
      outBytes.byteOffset,
      outBytes.byteOffset + outBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Page numbers added successfully.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_numbered.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: totalPages,
    };

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to add page numbers';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
