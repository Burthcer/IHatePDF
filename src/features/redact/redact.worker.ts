/**
 * Redact PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Redacted pages are replaced by images that were rendered on the main
 * thread with the black boxes already burned into the pixels — so no text,
 * vector or image data from under a box survives in any form. Pages without
 * redactions are copied over untouched (still searchable, still sharp).
 * Document metadata can be stripped as well.
 */

import { PDFDocument, PDFName } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import type { WorkerRequest, RedactPdfPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function redactPdf(payload: RedactPdfPayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, pages, stripMetadata } = payload;
  if (!pages.length) throw new Error('Mark at least one area to redact.');

  onProgress?.(10, 'Loading document...');
  const source = await openPdf(fileBuffer);
  const out = await PDFDocument.create();
  const total = source.getPageCount();
  const replaced = new Map(pages.map((p) => [p.pageIndex, p]));
  const keep = Array.from({ length: total }, (_, i) => i).filter((i) => !replaced.has(i));
  const copied = await out.copyPages(source, keep);
  const byIndex = new Map(keep.map((idx, k) => [idx, copied[k]]));

  for (let i = 0; i < total; i++) {
    const r = replaced.get(i);
    if (!r) {
      out.addPage(byIndex.get(i)!);
      continue;
    }
    onProgress?.(20 + Math.round((i / total) * 65), `Rebuilding page ${i + 1}...`);
    const image = await out.embedJpg(new Uint8Array(r.jpeg));
    const page = out.addPage([r.widthPt, r.heightPt]);
    page.drawImage(image, { x: 0, y: 0, width: r.widthPt, height: r.heightPt });
  }

  if (stripMetadata) {
    out.catalog.delete(PDFName.of('Metadata'));
    out.setTitle('');
    out.setAuthor('');
    out.setSubject('');
    out.setKeywords([]);
    out.setCreator('');
    out.setProducer('');
  } else {
    const title = source.getTitle();
    if (title) out.setTitle(title);
  }

  onProgress?.(92, 'Saving PDF...');
  const bytes = await out.save({ useObjectStreams: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Done.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_redacted.pdf`,
    buffer,
    size: buffer.byteLength,
    pageCount: total,
    note: `${pages.length} page${pages.length === 1 ? '' : 's'} flattened; ${total - pages.length} left untouched.`,
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RedactPdfPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'REDACT_PDF') return;
    try {
      const result = await redactPdf(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to redact PDF' } });
    }
  });
}
