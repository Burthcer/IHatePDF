/**
 * PDF to Word Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Builds a .docx from already-extracted, per-paragraph-sized page text
 * (extraction runs on the main thread via pdfjs-dist in usePdfRenderer,
 * since that's where the rest of this app's pdf.js usage already lives).
 *
 * A paragraph whose font size is notably larger than the document's median
 * body-text size is rendered as a real docx Heading (bold, larger, using
 * the actual detected size) instead of a plain paragraph — this recovers
 * real document structure (titles/section headers) that a flat text dump
 * would discard. Body paragraphs keep their actual detected font size too.
 *
 * What's NOT recovered: per-run color, bold/italic that isn't implied by
 * the heading heuristic, images, and tables (this PDF's tabular data is
 * better served by the dedicated PDF -> Excel tool, which does real
 * row/column detection) — see usePdfRenderer.extractPositionedText's doc
 * comment for why per-run color/weight isn't extracted from PDF text.
 */

import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';
import type {
  WorkerRequest,
  PdfToWordPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

const HEADING_RATIO = 1.25; // a paragraph this many times the median body size is a heading

function median(values: number[]): number {
  if (values.length === 0) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function pickHeadingLevel(sizePt: number, medianSize: number): (typeof HeadingLevel)[keyof typeof HeadingLevel] | undefined {
  const ratio = sizePt / medianSize;
  if (ratio >= HEADING_RATIO * 1.6) return HeadingLevel.HEADING_1;
  if (ratio >= HEADING_RATIO * 1.3) return HeadingLevel.HEADING_2;
  if (ratio >= HEADING_RATIO) return HeadingLevel.HEADING_3;
  return undefined;
}

/**
 * Builds a .docx from styled page text. Plain exported function (no
 * Worker/`self` dependency) so it's directly testable from a Node script —
 * see scripts/test-all-features.ts.
 */
export async function buildDocxFromPages(
  pages: PdfToWordPayload['pages'],
  fileName: string,
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  if (!pages || pages.length === 0) {
    throw new Error('No extracted text provided to convert.');
  }

  onProgress?.(15, 'Detecting document structure...');
  const allSizes = pages.flatMap((p) => p.paragraphs.map((para) => para.fontSizePt));
  const medianSize = median(allSizes);

  onProgress?.(30, 'Building document structure...');
  const children: Paragraph[] = [];

  pages.forEach((page) => {
    for (const para of page.paragraphs) {
      const headingLevel = pickHeadingLevel(para.fontSizePt, medianSize);
      children.push(
        new Paragraph({
          heading: headingLevel,
          children: [
            new TextRun({
              text: para.text,
              bold: !!headingLevel,
              size: Math.round(para.fontSizePt * 2), // docx uses half-points
            }),
          ],
        })
      );
    }
  });

  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('(No extractable text found.)')] }));
  }

  onProgress?.(70, 'Packing .docx archive...');
  const doc = new Document({ sections: [{ children }] });
  const arrayBuffer = await Packer.toArrayBuffer(doc);

  onProgress?.(100, 'Word document ready.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}.docx`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToWordPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'PDF_TO_WORD') return;

  try {
    const result = await buildDocxFromPages(payload.pages, payload.fileName, (progress, stage) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
      self.postMessage(msg);
    });
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert PDF to Word';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
