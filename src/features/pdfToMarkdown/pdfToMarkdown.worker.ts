/**
 * PDF to Markdown Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Formats already-extracted page text (same extraction as PDF -> Word) as
 * Markdown: one `##` heading per source page, paragraphs below it. No
 * heading/list/table structure detection from the source PDF — this is a
 * clean text dump, which is what most "PDF to Markdown for notes/LLMs"
 * use cases actually need.
 */

import type {
  WorkerRequest,
  PdfToMarkdownPayload,
  OfficeConversionResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<PdfToMarkdownPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PDF_TO_MARKDOWN') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { pages, fileName } = payload;
    if (!pages || pages.length === 0) throw new Error('No extracted text provided.');

    emitProgress(40, 'Formatting Markdown...');
    const lines: string[] = [];
    for (const page of pages) {
      lines.push(`## Page ${page.pageNumber}`, '');
      for (const para of page.paragraphs) {
        lines.push(para, '');
      }
    }
    const markdown = lines.join('\n').trimEnd() + '\n';

    emitProgress(90, 'Encoding file...');
    const bytes = new TextEncoder().encode(markdown);
    const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

    emitProgress(100, 'Markdown ready.');
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: OfficeConversionResult = {
      fileName: `${cleanBaseName}.md`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      mimeType: 'text/markdown',
    };
    const responseMsg: WorkerIncomingMessage<OfficeConversionResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to convert PDF to Markdown';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
