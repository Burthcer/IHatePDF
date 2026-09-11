/**
 * Unlock PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Decrypts AES-256 (revision 6) protected PDFs — including permission-only
 * restricted files that open with an empty user password — and re-saves an
 * unencrypted copy. pdf-lib cannot decrypt on its own; this worker drives
 * the hand-rolled decryption layer in src/services/pdfEncryptDocument.ts.
 */

import { PDFDocument } from 'pdf-lib';
import { decryptPdfDocument, serializeWithoutObjectStreams } from '../../services/pdfEncryptDocument';
import type {
  WorkerRequest,
  UnlockPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<UnlockPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'UNLOCK_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, password } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided to unlock.');
    }

    emitProgress(15, 'Parsing PDF structure and encryption dictionary...');
    const pdfDoc = await PDFDocument.load(fileBuffer, { ignoreEncryption: true });

    emitProgress(30, 'Flushing embedded document assets...');
    await pdfDoc.flush();

    if (pdfDoc.isEncrypted) {
      emitProgress(45, 'Verifying password and deriving decryption key...');
      const result = await decryptPdfDocument(pdfDoc, password || '');
      if (!result.success) {
        throw new Error(result.error || 'Failed to decrypt document.');
      }
      emitProgress(75, 'Removing security handler and restriction locks...');
    } else {
      emitProgress(60, 'Document has no encryption to remove.');
    }

    const pageCount = pdfDoc.getPageCount();

    emitProgress(90, 'Assembling unencrypted document stream...');
    const unlockedBytes = await serializeWithoutObjectStreams(pdfDoc);
    const resultBuffer = unlockedBytes.buffer.slice(
      unlockedBytes.byteOffset,
      unlockedBytes.byteOffset + unlockedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Document unlocked successfully.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_unlocked.pdf`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount,
    };

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: {
        id,
        success: true,
        data: result,
      },
    };

    // Zero-copy buffer transfer
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to unlock PDF document';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: {
        id,
        success: false,
        error: errorMsg,
      },
    };
    self.postMessage(responseMsg);
  }
});
