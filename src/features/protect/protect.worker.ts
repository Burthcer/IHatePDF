/**
 * Protect PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Encrypts PDF documents with real AES-256 (Standard Security Handler
 * revision 6) — see src/services/pdfCrypto.ts and pdfEncryptDocument.ts.
 * pdf-lib itself has no encryption support; this worker drives that
 * hand-rolled encryption layer directly.
 */

import { openPdf } from '../../services/pdfLoader';
import { encryptPdfDocument } from '../../services/pdfEncryptDocument';
import type { ProtectPayload, ProcessedPdfResult } from '../../types/worker';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

export async function protectPdf(
  payload: ProtectPayload,
  onProgress?: (progress: number, stage: string) => void,
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, userPassword, ownerPassword, permissions } = payload;
  if (!fileBuffer) {
    throw new Error('No PDF buffer provided for protection.');
  }
  if (!userPassword || userPassword.trim().length === 0) {
    throw new Error('User password is required to encrypt the document.');
  }

  onProgress?.(10, 'Loading and parsing PDF syntax tree...');
  // Already-protected files are decrypted first, then re-encrypted with the new password.
  const pdfDoc = await openPdf(fileBuffer);
  const pageCount = pdfDoc.getPageCount();

  onProgress?.(25, 'Flushing embedded document assets...');
  await pdfDoc.flush();

  onProgress?.(45, 'Deriving AES-256 encryption keys (this hashes the password ~64 rounds)...');
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

  onProgress?.(85, 'Writing encrypted document...');
  // Object streams stay off: the classic writer never adds unencrypted objects.
  const out = await emitPdf(pdfDoc, sink, { useObjectStreams: false, prepared: true });

  onProgress?.(100, 'Document encryption completed.');

  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_protected.pdf`,
    ...out,
    pageCount,
  };
}

serveTask<ProtectPayload, ProcessedPdfResult>('PROTECT_PDF', (p, ctx) => protectPdf(p, ctx.progress, ctx.sink()), 'Failed to protect PDF document');
