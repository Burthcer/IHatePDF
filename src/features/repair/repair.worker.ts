/**
 * Repair PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Two strategies:
 *  1. Structural: re-parse every object tolerantly (pdf-lib scans the file
 *     body itself instead of trusting a possibly-broken xref table, skips
 *     objects it can't read), then write a fresh, consistent file.
 *  2. Visual fallback: when (1) loses pages, the main thread renders what
 *     pdf.js can still display and this worker rebuilds the document from
 *     those page images.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRef } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import { salvagePdfBytes } from './salvage';
import type { WorkerRequest, RepairPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function repairPdf(payload: RepairPayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, renderedPages } = payload;
  const base = fileName.replace(/\.[^/.]+$/, '');

  if (renderedPages?.length) {
    const doc = await PDFDocument.create();
    for (let i = 0; i < renderedPages.length; i++) {
      onProgress?.(10 + Math.round((i / renderedPages.length) * 80), `Rebuilding page ${i + 1}...`);
      const p = renderedPages[i];
      const img = await doc.embedJpg(new Uint8Array(p.jpeg));
      doc.addPage([p.widthPt, p.heightPt]).drawImage(img, { x: 0, y: 0, width: p.widthPt, height: p.heightPt });
    }
    const bytes = await doc.save({ useObjectStreams: true });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return {
      fileName: `${base}_repaired.pdf`,
      buffer,
      size: buffer.byteLength,
      pageCount: renderedPages.length,
      note: `Rebuilt from rendered pages (${renderedPages.length}). Text in this copy isn’t selectable.`,
    };
  }

  onProgress?.(15, 'Re-reading every object in the file...');
  let pdfDoc: PDFDocument | null = null;
  let bytes = new Uint8Array(fileBuffer);
  let salvaged = 0;
  let lastError: unknown;
  // Unreadable objects are dropped one at a time (a truncated object stream is
  // partially recovered) until the rest of the file parses.
  for (let attempt = 0; attempt < 60 && !pdfDoc; attempt++) {
    try {
      pdfDoc = await openPdf(bytes);
    } catch (err) {
      lastError = err;
      const offset = /offset=(\d+)/.exec(err instanceof Error ? err.message : '')?.[1];
      const next = salvagePdfBytes(bytes, offset ? Number(offset) : undefined);
      if (!next || next.length === 0) break;
      bytes = new Uint8Array(next);
      salvaged++;
      onProgress?.(15 + Math.min(40, salvaged), `Skipping damaged data (${salvaged})...`);
    }
  }
  if (!pdfDoc) {
    throw new Error(`The file structure is too damaged to rebuild: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  let pageCount = 0;
  try {
    pageCount = pdfDoc.getPageCount();
  } catch {
    pageCount = 0;
  }
  if (pageCount === 0) pageCount = rebuildPageTree(pdfDoc);
  if (pageCount === 0) throw new Error('No readable pages were recovered from this file.');

  onProgress?.(60, 'Writing a clean copy...');
  const out = await pdfDoc.save({ useObjectStreams: true });
  const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Repair complete.');
  return { fileName: `${base}_repaired.pdf`, buffer, size: buffer.byteLength, pageCount, note: `Recovered ${pageCount} page${pageCount === 1 ? '' : 's'} with their original text and graphics.${salvaged ? ` ${salvaged} damaged section${salvaged === 1 ? ' was' : 's were'} skipped.` : ''}` };
}

/**
 * When the catalog or page tree was lost, gathers every surviving /Page
 * object (in file order) under a fresh page tree and catalog.
 */
function rebuildPageTree(doc: PDFDocument): number {
  const ctx = doc.context;
  const pages: Array<[PDFRef, PDFDict]> = [];
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')) pages.push([ref, obj]);
  }
  if (!pages.length) return 0;
  pages.sort((a, b) => a[0].objectNumber - b[0].objectNumber);
  const treeRef = ctx.nextRef();
  const kids = PDFArray.withContext(ctx);
  for (const [ref, dict] of pages) {
    kids.push(ref);
    dict.set(PDFName.of('Parent'), treeRef);
    // Attributes normally inherited from the lost parent.
    if (!dict.get(PDFName.of('MediaBox'))) dict.set(PDFName.of('MediaBox'), ctx.obj([0, 0, 612, 792]));
    if (!dict.get(PDFName.of('Resources'))) dict.set(PDFName.of('Resources'), ctx.obj({}));
  }
  ctx.assign(treeRef, ctx.obj({ Type: 'Pages', Kids: kids, Count: PDFNumber.of(pages.length) }));
  ctx.trailerInfo.Root = ctx.register(ctx.obj({ Type: 'Catalog', Pages: treeRef }));
  return pages.length;
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<RepairPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'REPAIR_PDF') return;
    try {
      const result = await repairPdf(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to repair PDF document' } });
    }
  });
}
