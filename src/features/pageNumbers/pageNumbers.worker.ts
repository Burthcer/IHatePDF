/**
 * Page Numbers Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps a number label on a range of pages, placed relative to the page as
 * displayed (so rotated/cropped pages get their number in the right spot),
 * with optional mirroring for double-sided layouts and custom templates
 * like "Page {n} of {total}".
 */

import { rgb } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import { fontForText } from '../../services/fonts';
import { withViewerFrame } from '../../services/pageOverlay';
import { hexToRgb01, computeAnchor, toRoman } from '../../services/pdfStampPosition';
import type { PageNumbersPayload, ProcessedPdfResult, WatermarkPosition } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

const MM_TO_PT = 72 / 25.4;

function formatLabel(payload: PageNumbersPayload, n: number, total: number): string {
  if (payload.template && payload.template.trim()) {
    return payload.template.replace(/\{n\}/g, String(n)).replace(/\{total\}/g, String(total)).replace(/\{roman\}/g, toRoman(n));
  }
  if (payload.format === 'roman') return toRoman(n);
  if (payload.format === 'n_of_total') return `Page ${n} of ${total}`;
  return String(n);
}

function mirrored(position: WatermarkPosition): WatermarkPosition {
  if (position.endsWith('left')) return position.replace('left', 'right') as WatermarkPosition;
  if (position.endsWith('right')) return position.replace('right', 'left') as WatermarkPosition;
  return position;
}

export async function addPageNumbers(
  payload: PageNumbersPayload,
  onProgress?: (progress: number, stage: string) => void,
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, position, fontSize, color, marginMm, startPage, endPage, startingNumber } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided.');

  onProgress?.(10, 'Loading PDF document...');
  const pdfDoc = await openPdf(fileBuffer);
  const pages = pdfDoc.getPages();
  const totalPages = pages.length;
  const from = Math.max(1, startPage) - 1;
  const to = Math.min(totalPages, endPage || totalPages) - 1;
  const countTotal = to - from + 1 + (startingNumber - 1);
  const labels: string[] = [];
  for (let i = from; i <= to; i++) labels.push(formatLabel(payload, startingNumber + (i - from), countTotal));
  const font = await fontForText(pdfDoc, { family: 'sans', bold: false, italic: false }, labels.join(' '));
  const { r, g, b } = hexToRgb01(color);
  const marginPt = marginMm * MM_TO_PT;

  onProgress?.(35, 'Stamping page numbers...');
  for (let i = from; i <= to; i++) {
    const page = pages[i];
    const label = labels[i - from];
    const pos = payload.mirror && (i - from) % 2 === 1 ? mirrored(position) : position;
    withViewerFrame(page, ({ width, height }) => {
      const textWidth = font.widthOfTextAtSize(label, fontSize);
      const textHeight = font.heightAtSize(fontSize, { descender: false });
      const { x, y } = computeAnchor(width, height, textWidth, textHeight, pos, marginPt);
      page.drawText(label, { x, y, size: fontSize, font, color: rgb(r, g, b) });
    });
    if (to > from) onProgress?.(35 + Math.round(((i - from) / (to - from)) * 50), `Stamping page ${i + 1}...`);
  }

  onProgress?.(90, 'Saving document...');
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: true });
  onProgress?.(100, 'Page numbers added.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_numbered.pdf`,
    ...out,
    pageCount: totalPages,
  };
}

serveTask<PageNumbersPayload, ProcessedPdfResult>('ADD_PAGE_NUMBERS', (p, ctx) => addPageNumbers(p, ctx.progress, ctx.sink()), 'Failed to add page numbers');
