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

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  PageBreak,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import type { LayoutBlock, PageLayout, StyledRun } from '../../services/textLayout';
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

function runsToDocx(runs: StyledRun[], sizeOverride?: number): TextRun[] {
  return runs.map(
    (r) =>
      new TextRun({
        text: r.text,
        bold: r.bold,
        italics: r.italic,
        size: Math.round((sizeOverride ?? r.size) * 2),
        font: r.mono ? 'Courier New' : r.serif ? 'Times New Roman' : 'Calibri',
      })
  );
}

const ALIGN = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
} as const;

function blockToDocx(block: LayoutBlock): Array<Paragraph | Table> {
  switch (block.kind) {
    case 'heading':
      return [
        new Paragraph({
          heading: block.level === 1 ? HeadingLevel.HEADING_1 : block.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3,
          children: runsToDocx(block.runs).map((r) => r),
        }),
      ];
    case 'paragraph':
      return [new Paragraph({ alignment: ALIGN[block.align], spacing: { after: 120 }, children: runsToDocx(block.runs) })];
    case 'list':
      return block.items.map((item, i) =>
        block.ordered
          ? new Paragraph({ indent: { left: 440, hanging: 280 }, spacing: { after: 60 }, children: [new TextRun({ text: `${item.marker || `${i + 1}.`}\t` }), ...runsToDocx(item.runs)] })
          : new Paragraph({ bullet: { level: 0 }, spacing: { after: 60 }, children: runsToDocx(item.runs) })
      );
    case 'table': {
      const cols = Math.max(...block.rows.map((r) => r.length));
      const border = { style: BorderStyle.SINGLE, size: 4, color: 'BFBFBF' };
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: block.rows.map(
            (row, ri) =>
              new TableRow({
                children: Array.from({ length: cols }, (_, ci) =>
                  new TableCell({
                    borders: { top: border, bottom: border, left: border, right: border },
                    children: [new Paragraph({ children: [new TextRun({ text: row[ci] ?? '', bold: ri === 0, size: 20 })] })],
                  })
                ),
              })
          ),
        }),
        new Paragraph({ children: [] }),
      ];
    }
  }
}

/** Builds a .docx from analyzed page layouts (headings, lists, tables, styled runs). */
export async function buildDocxFromLayout(
  pages: PageLayout[],
  fileName: string,
  options: { pageBreaks: boolean },
  onProgress?: (progress: number, stage: string) => void
): Promise<OfficeConversionResult> {
  onProgress?.(20, 'Building document...');
  const children: Array<Paragraph | Table> = [];
  pages.forEach((page, pi) => {
    page.blocks.forEach((b) => children.push(...blockToDocx(b)));
    if (options.pageBreaks && pi < pages.length - 1) children.push(new Paragraph({ children: [new PageBreak()] }));
  });
  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun('(This PDF has no extractable text — it may be a scan. Try OCR software first.)')] }));
  }
  const first = pages[0];
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    sections: [
      {
        properties: first
          ? { page: { size: { width: Math.round(first.width * 20), height: Math.round(first.height * 20) }, margin: { top: 1080, bottom: 1080, left: 1080, right: 1080 } } }
          : {},
        children,
      },
    ],
  });
  onProgress?.(70, 'Packing .docx archive...');
  const arrayBuffer = await Packer.toArrayBuffer(doc);
  onProgress?.(100, 'Word document ready.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}.docx`,
    buffer: arrayBuffer,
    size: arrayBuffer.byteLength,
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToWordPayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'PDF_TO_WORD') return;

  try {
    const progress = (p: number, stage: string) => {
      const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress: p, stage } };
      self.postMessage(msg);
    };
    const result = payload.layout
      ? await buildDocxFromLayout(payload.layout, payload.fileName, { pageBreaks: payload.pageBreaks ?? false }, progress)
      : await buildDocxFromPages(payload.pages, payload.fileName, progress);
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
