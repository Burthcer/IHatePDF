/**
 * Organize PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reorders, duplicates, and deletes pages in a document using pdf-lib.
 *
 * `organizePdfPages` is a plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script — see
 * scripts/verify-conversions.ts.
 */

import { PDFDocument, degrees, type PDFPage } from 'pdf-lib';
import { appendPages, newPage } from '../../services/pageTree';
import { openPdf } from '../../services/pdfLoader';
import type { OrganizePayload, ProcessedPdfResult, PdfInput } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function organizePdfPages(
  fileBuffer: PdfInput,
  fileName: string,
  pageOrder: number[],
  deletedPages: number[] = [],
  onProgress?: (progress: number, stage: string) => void,
  rotations: number[] = [],
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  if (!fileBuffer) throw new Error('No PDF buffer provided for organization.');

  onProgress?.(15, 'Loading source PDF document...');
  const sourceDoc = await openPdf(fileBuffer);
  const totalSourcePages = sourceDoc.getPageCount();

  // -1 in pageOrder inserts a blank page (sized like its neighbour);
  // rotations[i] adds that many degrees to output page i.
  const deletedSet = new Set(deletedPages);
  const entries = pageOrder
    .map((idx, i) => ({ idx, rotate: rotations[i] ?? 0 }))
    .filter(({ idx }) => idx === -1 || (!deletedSet.has(idx) && idx >= 0 && idx < totalSourcePages));

  if (entries.length === 0 || entries.every((e) => e.idx === -1)) {
    throw new Error('Cannot create an empty PDF. At least one page must remain.');
  }

  onProgress?.(35, 'Allocating new organized document...');
  const organizedDoc = await PDFDocument.create();
  const sourceIndices = entries.filter((e) => e.idx >= 0).map((e) => e.idx);

  onProgress?.(55, `Copying ${entries.length} pages in new order...`);
  const copiedPages = await organizedDoc.copyPages(sourceDoc, sourceIndices);
  let k = 0;
  let lastSize: [number, number] = [595.28, 841.89];
  const ordered: PDFPage[] = [];
  entries.forEach((e, i) => {
    if (e.idx === -1) {
      const next = entries.slice(i + 1).find((x) => x.idx >= 0);
      const size = next ? sourceDoc.getPage(next.idx).getSize() : { width: lastSize[0], height: lastSize[1] };
      const blank = newPage(organizedDoc, [size.width, size.height]);
      if (e.rotate) blank.setRotation(degrees(((e.rotate % 360) + 360) % 360));
      ordered.push(blank);
      return;
    }
    const page = copiedPages[k++];
    ordered.push(page);
    const { width, height } = page.getSize();
    lastSize = [width, height];
    if (e.rotate) page.setRotation(degrees((((page.getRotation().angle + e.rotate) % 360) + 360) % 360));
  });
  appendPages(organizedDoc, ordered);

  onProgress?.(85, 'Writing the organized document...');
  const out = await emitPdf(organizedDoc, sink, { useObjectStreams: true });

  onProgress?.(100, 'Page organization complete.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_organized.pdf`,
    ...out,
    pageCount: entries.length,
  };
}

serveTask<OrganizePayload, ProcessedPdfResult>(
  'ORGANIZE_PAGES',
  (p, ctx) => organizePdfPages(p.fileBuffer, p.fileName, p.pageOrder, p.deletedPages, ctx.progress, p.rotations, ctx.sink()),
  'Failed to organize PDF pages'
);
