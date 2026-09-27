/**
 * Sign PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps a signature image (drawn, typed or uploaded — rasterized to PNG on
 * the main thread) at one or more positions chosen on the page preview.
 * Positions are in "as displayed" coordinates, so rotated pages work.
 * This is a visual signature, not a cryptographic (PKI) one.
 */

import { openPdf } from '../../services/pdfLoader';
import { withViewerFrame } from '../../services/pageOverlay';
import type { WorkerRequest, StampSignaturePayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function stampSignature(payload: StampSignaturePayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, signatureImageBytes, placements } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided.');
  if (!signatureImageBytes) throw new Error('No signature image provided.');
  if (!placements.length) throw new Error('Place the signature on at least one page.');

  onProgress?.(20, 'Loading document...');
  const pdfDoc = await openPdf(fileBuffer);
  const pages = pdfDoc.getPages();

  onProgress?.(50, 'Embedding signature...');
  const image = await pdfDoc.embedPng(new Uint8Array(signatureImageBytes));
  for (const p of placements) {
    const page = pages[p.pageIndex];
    if (!page) continue;
    withViewerFrame(page, ({ height }) => {
      page.drawImage(image, { x: p.x, y: height - p.y - p.height, width: p.width, height: p.height });
    });
  }

  onProgress?.(85, 'Saving PDF...');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Signed.');
  return { fileName: `${fileName.replace(/\.[^/.]+$/, '')}_signed.pdf`, buffer, size: buffer.byteLength, pageCount: pages.length };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<StampSignaturePayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'STAMP_SIGNATURE') return;
    try {
      const result = await stampSignature(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to sign PDF document' } });
    }
  });
}
