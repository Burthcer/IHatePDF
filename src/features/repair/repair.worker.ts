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

import { PDFDocument } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
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
  let pdfDoc: PDFDocument;
  try {
    pdfDoc = await openPdf(fileBuffer);
  } catch (err) {
    throw new Error(`The file structure is too damaged to rebuild: ${err instanceof Error ? err.message : String(err)}`);
  }
  const pageCount = pdfDoc.getPageCount();
  if (pageCount === 0) throw new Error('No readable pages were recovered from this file.');

  onProgress?.(60, 'Writing a clean copy...');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Repair complete.');
  return { fileName: `${base}_repaired.pdf`, buffer, size: buffer.byteLength, pageCount, note: `Recovered ${pageCount} page${pageCount === 1 ? '' : 's'} with their original text and graphics.` };
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
