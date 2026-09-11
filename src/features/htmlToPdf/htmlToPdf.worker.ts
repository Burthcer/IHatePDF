/**
 * HTML to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Lays out pre-parsed HTML blocks (headings, paragraphs, list items — parsed
 * from the source HTML on the main thread via DOMParser, since that API
 * isn't available inside a Worker) into a new PDF with manual word-wrap and
 * pagination. This preserves document structure and basic emphasis, not
 * CSS layout, images, or styling.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { WorkerRequest, HtmlToPdfPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const BLOCK_STYLE: Record<string, { size: number; gapAfter: number }> = {
  h1: { size: 24, gapAfter: 14 },
  h2: { size: 19, gapAfter: 11 },
  h3: { size: 15, gapAfter: 9 },
  p: { size: 11, gapAfter: 8 },
  li: { size: 11, gapAfter: 4 },
};

function wrapLine(text: string, maxWidth: number, measure: (s: string) => number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [''];
  const lines: string[] = [];
  let current = words[0];
  for (let i = 1; i < words.length; i++) {
    const candidate = current + ' ' + words[i];
    if (measure(candidate) <= maxWidth) {
      current = candidate;
    } else {
      lines.push(current);
      current = words[i];
    }
  }
  lines.push(current);
  return lines;
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<HtmlToPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'HTML_TO_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { blocks, fileName } = payload;
    if (!blocks || blocks.length === 0) throw new Error('No HTML content to convert.');

    emitProgress(15, 'Preparing layout...');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
    const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);
    const maxWidth = PAGE_WIDTH - MARGIN * 2;

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    const ensureSpace = (lineHeight: number) => {
      if (y < MARGIN + lineHeight) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
    };

    emitProgress(30, 'Laying out blocks...');
    blocks.forEach((block, idx) => {
      const style = BLOCK_STYLE[block.type] || BLOCK_STYLE.p;
      const activeFont = block.bold ? boldFont : block.italic ? italicFont : font;
      const lineHeight = style.size * 1.35;
      const indent = block.type === 'li' ? 16 : 0;
      const bullet = block.type === 'li' ? '• ' : '';
      const measure = (s: string) => activeFont.widthOfTextAtSize(s, style.size);
      const lines = wrapLine(bullet + block.text, maxWidth - indent, measure);

      lines.forEach((line) => {
        ensureSpace(lineHeight);
        page.drawText(line, { x: MARGIN + indent, y, size: style.size, font: activeFont, color: rgb(0.08, 0.08, 0.08) });
        y -= lineHeight;
      });
      y -= style.gapAfter;

      emitProgress(30 + Math.round(((idx + 1) / blocks.length) * 60), `Laying out block ${idx + 1}/${blocks.length}...`);
    });

    emitProgress(95, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const resultBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '') || 'document';
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}.pdf`,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert HTML to PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
