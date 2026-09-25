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

import { openPdf, PdfPasswordError, wasEncrypted } from '../../services/pdfLoader';
import type { WorkerRequest, UnlockPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

export async function unlockPdf(
  payload: UnlockPayload,
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult & { wasEncrypted: boolean }> {
  const { fileBuffer, fileName, password } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided to unlock.');

  onProgress?.(15, 'Reading encryption dictionary...');
  const pdfDoc = await openPdf(fileBuffer, { password });
  const encrypted = wasEncrypted(pdfDoc);

  onProgress?.(70, encrypted ? 'Writing an unencrypted copy...' : 'This document was not encrypted — saving a clean copy...');
  const bytes = await pdfDoc.save({ useObjectStreams: true });
  const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  onProgress?.(100, 'Unlocked.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_unlocked.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: pdfDoc.getPageCount(),
    wasEncrypted: encrypted,
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener('message', async (event: MessageEvent<WorkerRequest<UnlockPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'UNLOCK_PDF') return;

    try {
      const result = await unlockPdf(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        (self as any).postMessage(msg);
      });
      const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = { type: 'RESPONSE', payload: { id, success: true, data: result } };
      (self as any).postMessage(responseMsg, [result.buffer]);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Failed to unlock PDF document';
      const code = err instanceof PdfPasswordError ? err.code : undefined;
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: false, error: errorMsg, code } });
    }
  });
}
