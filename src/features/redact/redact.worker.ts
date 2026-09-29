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

import { PDFDocument, PDFName, type PDFPage } from 'pdf-lib';
import { appendPages, newPage } from '../../services/pageTree';
import { openPdf } from '../../services/pdfLoader';
import type { RedactPdfPayload, ProcessedPdfResult } from '../../types/worker';
import { drawImageFull, embedJpegSource } from '../../services/lazyImage';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function redactPdf(payload: RedactPdfPayload, onProgress?: (p: number, s: string) => void, sink?: OutputSink): Promise<ProcessedPdfResult> {
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

  const ordered: PDFPage[] = [];
  for (let i = 0; i < total; i++) {
    const r = replaced.get(i);
    if (!r) {
      ordered.push(byIndex.get(i)!);
      continue;
    }
    onProgress?.(20 + Math.round((i / total) * 65), `Rebuilding page ${i + 1}...`);
    const image = await embedJpegSource(out, r.jpeg);
    const page = newPage(out, [r.widthPt, r.heightPt]);
    drawImageFull(page, image, r.widthPt, r.heightPt);
    ordered.push(page);
  }
  appendPages(out, ordered);

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
  const written = await emitPdf(out, sink, { useObjectStreams: true });
  onProgress?.(100, 'Done.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_redacted.pdf`,
    ...written,
    pageCount: total,
    note: `${pages.length} page${pages.length === 1 ? '' : 's'} flattened; ${total - pages.length} left untouched.`,
  };
}

serveTask<RedactPdfPayload, ProcessedPdfResult>('REDACT_PDF', (p, ctx) => redactPdf(p, ctx.progress, ctx.sink()), 'Failed to redact PDF');
