/**
 * Unlock PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Removes encryption from any Standard-security PDF — RC4 40/128-bit,
 * AES-128 and AES-256 (revisions 2-6) — given the open password, or with no
 * password at all for "owner password only" files that restrict printing,
 * copying or editing. Also used at ingestion to decrypt protected files so
 * every other tool receives a plain PDF.
 */

import { openPdf, wasEncrypted } from '../../services/pdfLoader';
import type { UnlockPayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function unlockPdf(
  payload: UnlockPayload,
  onProgress?: (progress: number, stage: string) => void,
  sink?: OutputSink
): Promise<ProcessedPdfResult & { wasEncrypted: boolean }> {
  const { fileBuffer, fileName, password } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided to unlock.');

  onProgress?.(15, 'Reading encryption dictionary...');
  const pdfDoc = await openPdf(fileBuffer, { password });
  const encrypted = wasEncrypted(pdfDoc);

  onProgress?.(70, encrypted ? 'Writing an unencrypted copy...' : 'This document was not encrypted — saving a clean copy...');
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: true });

  onProgress?.(100, 'Unlocked.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_unlocked.pdf`,
    ...out,
    pageCount: pdfDoc.getPageCount(),
    wasEncrypted: encrypted,
  };
}

serveTask<UnlockPayload, ProcessedPdfResult>('UNLOCK_PDF', (p, ctx) => unlockPdf(p, ctx.progress, ctx.sink()), 'Failed to unlock PDF document');
