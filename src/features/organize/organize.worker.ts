/**
 * Organize PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Reorders, duplicates, and deletes pages in a document using pdf-lib.
 *
 * `organizePdfPages` is a plain exported function (no Worker/`self`
 * dependency) so it's directly testable from a Node script — see
 * scripts/test-all-features.ts.
 */

import { PDFDocument, degrees } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import type { WorkerRequest, OrganizePayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function organizePdfPages(
  fileBuffer: ArrayBuffer,
  fileName: string,
  pageOrder: number[],
  deletedPages: number[] = [],
  onProgress?: (progress: number, stage: string) => void,
  rotations: number[] = []
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
  entries.forEach((e, i) => {
    if (e.idx === -1) {
      const next = entries.slice(i + 1).find((x) => x.idx >= 0);
      const size = next ? sourceDoc.getPage(next.idx).getSize() : { width: lastSize[0], height: lastSize[1] };
      const blank = organizedDoc.addPage([size.width, size.height]);
      if (e.rotate) blank.setRotation(degrees(((e.rotate % 360) + 360) % 360));
      return;
    }
    const page = organizedDoc.addPage(copiedPages[k++]);
    const { width, height } = page.getSize();
    lastSize = [width, height];
    if (e.rotate) page.setRotation(degrees((((page.getRotation().angle + e.rotate) % 360) + 360) % 360));
  });

  onProgress?.(85, 'Serializing new document structure...');
  const organizedBytes = await organizedDoc.save({ useObjectStreams: true });
  const resultBuffer = organizedBytes.buffer.slice(
    organizedBytes.byteOffset,
    organizedBytes.byteOffset + organizedBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Page organization complete.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_organized.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: entries.length,
  };
}

if (typeof self !== 'undefined') self.addEventListener('message', async (event: MessageEvent<WorkerRequest<OrganizePayload>>) => {
  const { id, action, payload } = event.data;
  if (action !== 'ORGANIZE_PAGES') return;

  try {
    const result = await organizePdfPages(
      payload.fileBuffer,
      payload.fileName,
      payload.pageOrder,
      payload.deletedPages,
      (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      },
      payload.rotations
    );
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to organize PDF pages';
    const responseMsg: WorkerIncomingMessage = { type: 'RESPONSE', payload: { id, success: false, error: errorMsg } };
    self.postMessage(responseMsg);
  }
});
