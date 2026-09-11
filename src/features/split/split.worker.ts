/**
 * Split PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Extracts selected page ranges or splits PDF into distinct documents.
 */

import { PDFDocument } from 'pdf-lib';
import { createZip } from '../../services/zipWriter';
import type {
  WorkerRequest,
  SplitPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<SplitPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'SPLIT_PDF') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = {
      type: 'PROGRESS',
      payload: { id, progress, stage },
    };
    self.postMessage(msg);
  };

  try {
    const { fileBuffer, fileName, ranges } = payload;
    if (!fileBuffer) {
      throw new Error('No PDF buffer supplied for splitting.');
    }

    emitProgress(10, 'Loading source PDF document...');
    const sourceDoc = await PDFDocument.load(fileBuffer);
    const totalPages = sourceDoc.getPageCount();
    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');

    let result: ProcessedPdfResult;

    if (ranges === 'all') {
      // Burst mode: every page becomes its own single-page PDF, packaged into one ZIP.
      const zipEntries: { name: string; data: Uint8Array }[] = [];
      const pad = String(totalPages).length;

      for (let i = 0; i < totalPages; i++) {
        emitProgress(
          10 + Math.round((i / totalPages) * 75),
          `Extracting page ${i + 1} of ${totalPages}...`
        );
        const pageDoc = await PDFDocument.create();
        const [copiedPage] = await pageDoc.copyPages(sourceDoc, [i]);
        pageDoc.addPage(copiedPage);
        const pageBytes = await pageDoc.save();
        zipEntries.push({
          name: `${cleanBaseName}_page_${String(i + 1).padStart(pad, '0')}.pdf`,
          data: pageBytes,
        });
      }

      emitProgress(90, `Packaging ${totalPages} pages into a ZIP archive...`);
      const zipBytes = createZip(zipEntries);
      const resultBuffer = zipBytes.buffer.slice(
        zipBytes.byteOffset,
        zipBytes.byteOffset + zipBytes.byteLength
      ) as ArrayBuffer;

      result = {
        fileName: `${cleanBaseName}_pages.zip`,
        buffer: resultBuffer,
        size: resultBuffer.byteLength,
        pageCount: totalPages,
      };
    } else {
      // Range mode: one or more page ranges, combined into a single extracted PDF.
      const targetDoc = await PDFDocument.create();
      const pageIndicesToCopy: number[] = [];

      if (Array.isArray(ranges)) {
        for (const range of ranges) {
          const start = Math.max(0, range.from - 1);
          const end = Math.min(totalPages - 1, range.to - 1);
          for (let p = start; p <= end; p++) {
            if (!pageIndicesToCopy.includes(p)) {
              pageIndicesToCopy.push(p);
            }
          }
        }
      }

      if (pageIndicesToCopy.length === 0) {
        throw new Error('No valid pages selected to extract.');
      }

      emitProgress(60, `Extracting ${pageIndicesToCopy.length} pages...`);
      const copiedPages = await targetDoc.copyPages(sourceDoc, pageIndicesToCopy);
      for (const page of copiedPages) {
        targetDoc.addPage(page);
      }

      emitProgress(85, 'Serializing extracted PDF...');
      const splitBytes = await targetDoc.save();
      const resultBuffer = splitBytes.buffer.slice(
        splitBytes.byteOffset,
        splitBytes.byteOffset + splitBytes.byteLength
      ) as ArrayBuffer;

      result = {
        fileName: `${cleanBaseName}_split.pdf`,
        buffer: resultBuffer,
        size: resultBuffer.byteLength,
        pageCount: pageIndicesToCopy.length,
      };
    }

    emitProgress(100, 'Split operation complete.');

    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: {
        id,
        success: true,
        data: result,
      },
    };

    // Zero-copy buffer transfer
    (self as any).postMessage(responseMsg, [result.buffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to split PDF document';
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
