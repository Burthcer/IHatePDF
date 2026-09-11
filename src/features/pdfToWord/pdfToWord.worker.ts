/**
 * PDF to Word Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Builds a .docx from already-extracted page text (extraction runs on the
 * main thread via pdfjs-dist in usePdfRenderer, since that's where the rest
 * of this app's pdf.js usage already lives). Text-only: layout, images, and
 * tables from the source PDF are not preserved — each PDF page becomes a
 * heading + its paragraphs.
 */

import { Document, Paragraph, TextRun, HeadingLevel, Packer } from 'docx';
import type {
  WorkerRequest,
  PdfToWordPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToWordPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PDF_TO_WORD') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { pages, fileName } = payload;
    if (!pages || pages.length === 0) {
      throw new Error('No extracted text provided to convert.');
    }

    emitProgress(20, 'Building document structure...');
    const children: Paragraph[] = [];

    pages.forEach((page, idx) => {
      children.push(
        new Paragraph({
          heading: HeadingLevel.HEADING_3,
          children: [new TextRun(`Page ${page.pageNumber}`)],
        })
      );
      for (const para of page.paragraphs) {
        children.push(new Paragraph({ children: [new TextRun(para)] }));
      }
      if (idx < pages.length - 1) {
        children.push(new Paragraph({ children: [], pageBreakBefore: false }));
      }
    });

    if (children.length === 0) {
      children.push(new Paragraph({ children: [new TextRun('(No extractable text found.)')] }));
    }

    emitProgress(60, 'Packing .docx archive...');
    const doc = new Document({ sections: [{ children }] });
    const blob = await Packer.toBlob(doc);
    const arrayBuffer = await blob.arrayBuffer();

    emitProgress(100, 'Word document ready.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.docx`,
      buffer: arrayBuffer,
      size: arrayBuffer.byteLength,
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };

    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [arrayBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert PDF to Word';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
