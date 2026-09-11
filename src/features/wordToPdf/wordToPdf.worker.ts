/**
 * Word to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Extracts plain text from a .docx via mammoth (extractRawText — text only,
 * no DOMParser/HTML step, which keeps this reliable inside a Worker), then
 * lays it out into a new PDF with manual word-wrap and pagination via
 * pdf-lib. Bold/italic/images/tables from the source document are not
 * preserved — this carries the actual text content over, not the visual
 * layout.
 */

import mammoth from 'mammoth';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type {
  WorkerRequest,
  WordToPdfPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const PAGE_WIDTH = 612; // US Letter, points
const PAGE_HEIGHT = 792;
const MARGIN = 54; // 0.75in
const FONT_SIZE = 11;
const LINE_HEIGHT = FONT_SIZE * 1.4;
const PARAGRAPH_GAP = FONT_SIZE * 0.6;

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

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<WordToPdfPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'WORD_TO_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName } = payload;
    if (!fileBuffer) throw new Error('No Word document provided.');

    emitProgress(15, 'Extracting text from .docx...');
    const { value: rawText } = await mammoth.extractRawText({ arrayBuffer: fileBuffer });
    const paragraphs = rawText.split(/\n+/).map((p) => p.trim()).filter(Boolean);

    emitProgress(35, 'Laying out PDF pages...');
    const pdfDoc = await PDFDocument.create();
    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const maxWidth = PAGE_WIDTH - MARGIN * 2;
    const measure = (s: string) => font.widthOfTextAtSize(s, FONT_SIZE);

    let page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let y = PAGE_HEIGHT - MARGIN;

    const ensureSpace = () => {
      if (y < MARGIN + LINE_HEIGHT) {
        page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        y = PAGE_HEIGHT - MARGIN;
      }
    };

    if (paragraphs.length === 0) {
      page.drawText('(No extractable text found in this document.)', {
        x: MARGIN,
        y,
        size: FONT_SIZE,
        font,
        color: rgb(0.3, 0.3, 0.3),
      });
    }

    paragraphs.forEach((para, idx) => {
      const lines = wrapLine(para, maxWidth, measure);
      for (const line of lines) {
        ensureSpace();
        page.drawText(line, { x: MARGIN, y, size: FONT_SIZE, font, color: rgb(0.1, 0.1, 0.1) });
        y -= LINE_HEIGHT;
      }
      y -= PARAGRAPH_GAP;
      if (idx % 20 === 0) {
        emitProgress(35 + Math.round((idx / paragraphs.length) * 45), `Laying out paragraph ${idx + 1}/${paragraphs.length}...`);
      }
    });

    emitProgress(85, 'Saving PDF...');
    const pdfBytes = await pdfDoc.save();
    const arrayBuffer = pdfBytes.buffer.slice(
      pdfBytes.byteOffset,
      pdfBytes.byteOffset + pdfBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'PDF ready.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.pdf`,
      buffer: arrayBuffer,
      size: arrayBuffer.byteLength,
      mimeType: 'application/pdf',
    };

    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [arrayBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert Word document to PDF';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
