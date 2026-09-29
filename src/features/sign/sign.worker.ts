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
import type { StampSignaturePayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function stampSignature(payload: StampSignaturePayload, onProgress?: (p: number, s: string) => void, sink?: OutputSink): Promise<ProcessedPdfResult> {
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
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: true });
  onProgress?.(100, 'Signed.');
  return { fileName: `${fileName.replace(/\.[^/.]+$/, '')}_signed.pdf`, ...out, pageCount: pages.length };
}

serveTask<StampSignaturePayload, ProcessedPdfResult>('STAMP_SIGNATURE', (p, ctx) => stampSignature(p, ctx.progress, ctx.sink()), 'Failed to sign PDF document');
