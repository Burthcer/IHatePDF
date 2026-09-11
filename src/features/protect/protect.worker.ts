/**
 * Protect PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Encrypts PDF documents with real AES-256 (Standard Security Handler
 * revision 6) — see src/services/pdfCrypto.ts and pdfEncryptDocument.ts.
 * pdf-lib itself has no encryption support; this worker drives that
 * hand-rolled encryption layer directly.
 */

import { PDFDocument } from 'pdf-lib';
import { encryptPdfDocument, serializeWithoutObjectStreams } from '../../services/pdfEncryptDocument';
import type {
  WorkerRequest,
  ProtectPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<ProtectPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'PROTECT_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, userPassword, ownerPassword, permissions } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer provided for protection.');
    }
    if (!userPassword || userPassword.trim().length === 0) {
      throw new Error('User password is required to encrypt the document.');
    }

    emitProgress(10, 'Loading and parsing PDF syntax tree...');
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pageCount = pdfDoc.getPageCount();

    emitProgress(25, 'Flushing embedded document assets...');
    await pdfDoc.flush();

    emitProgress(45, 'Deriving AES-256 encryption keys (this hashes the password ~64 rounds)...');
    await encryptPdfDocument(pdfDoc, {
      userPassword,
      ownerPassword: ownerPassword || userPassword,
      permissions: permissions
        ? {
            printing: permissions.printing !== false,
            modifying: permissions.modifying !== false,
            copying: permissions.copying !== false,
            annotating: permissions.annotating !== false,
          }
        : undefined,
    });

    emitProgress(85, 'Serializing encrypted document...');
    const protectedBytes = await serializeWithoutObjectStreams(pdfDoc);
    const resultBuffer = protectedBytes.buffer.slice(
      protectedBytes.byteOffset,
      protectedBytes.byteOffset + protectedBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'Document encryption completed.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_protected.pdf`,
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
    const errorMsg = err instanceof Error ? err.message : 'Failed to protect PDF document';
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
