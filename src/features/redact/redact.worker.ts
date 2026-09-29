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

import { PDFDocument, PDFName, type PDFPage, type PDFRef } from 'pdf-lib';
import { appendPages, newPage } from '../../services/pageTree';
import { openPdf } from '../../services/pdfLoader';
import type { RedactPdfPayload, ProcessedPdfResult, RedactedPageRender } from '../../types/worker';
import type { DeferredStream } from '../../services/pdfStreamSave';
import { drawImageFull, embedJpegSource } from '../../services/lazyImage';
import { emitPdf, emitSequential } from '../../services/workerEmit';
import { serveTask, type TaskContext } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function redactPdf(
  payload: RedactPdfPayload,
  onProgress?: (p: number, s: string) => void,
  sink?: OutputSink,
  ask?: TaskContext['ask']
): Promise<ProcessedPdfResult> {
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
  // Renders not supplied up front are asked for one at a time while writing.
  const deferred = new Map<PDFRef, DeferredStream>();
  let written = 0;
  for (let i = 0; i < total; i++) {
    const r = replaced.get(i);
    if (!r) {
      ordered.push(byIndex.get(i)!);
      continue;
    }
    const page = newPage(out, [r.widthPt, r.heightPt]);
    if (r.jpeg) {
      onProgress?.(20 + Math.round((i / total) * 65), `Rebuilding page ${i + 1}...`);
      drawImageFull(page, await embedJpegSource(out, r.jpeg), r.widthPt, r.heightPt);
    } else {
      if (!ask) throw new Error('Redacted page images are missing.');
      const ref = out.context.nextRef();
      drawImageFull(page, { ref, width: 0, height: 0 }, r.widthPt, r.heightPt);
      deferred.set(ref, {
        produce: async () => {
          onProgress?.(10 + Math.round((written / pages.length) * 85), `Redacting page ${r.pageIndex + 1} (${++written} of ${pages.length})...`);
          const img = await ask<RedactedPageRender>('redacted-page', { pageIndex: r.pageIndex });
          const dict = out.context.obj({ Type: 'XObject', Subtype: 'Image', Width: img.width, Height: img.height, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'DCTDecode' });
          return { dict, bytes: new Uint8Array(img.jpeg) };
        },
      });
    }
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

  onProgress?.(deferred.size ? 10 : 92, 'Saving PDF...');
  const saved = deferred.size ? await emitSequential(out, sink, deferred) : await emitPdf(out, sink, { useObjectStreams: true });
  onProgress?.(100, 'Done.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_redacted.pdf`,
    ...saved,
    pageCount: total,
    note: `${pages.length} page${pages.length === 1 ? '' : 's'} flattened; ${total - pages.length} left untouched.`,
  };
}

serveTask<RedactPdfPayload, ProcessedPdfResult>('REDACT_PDF', (p, ctx) => redactPdf(p, ctx.progress, ctx.sink(), ctx.ask), 'Failed to redact PDF');
