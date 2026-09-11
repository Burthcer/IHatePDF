/**
 * PDF to JPG Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Packs already-rendered page images (rendered on the main thread via
 * usePdfRenderer, same as PDF -> PPTX) into a ZIP, reusing the STORED-format
 * zipWriter.ts already built for Split's "Extract All Pages".
 */

import { createZip } from '../../services/zipWriter';
import type {
  WorkerRequest,
  BuildJpgZipPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

function dataUrlToBytes(dataUrl: string): Uint8Array {
  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

self.addEventListener('message', async (event: MessageEvent<WorkerRequest<BuildJpgZipPayload>>) => {
  const { id, action, payload } = event.data;

  if (action !== 'BUILD_JPG_ZIP') return;

  const emitProgress = (progress: number, stage: string) => {
    const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
    self.postMessage(msg);
  };

  try {
    const { images, fileName } = payload;
    if (!images || images.length === 0) throw new Error('No rendered pages to export.');

    const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');

    if (images.length === 1) {
      emitProgress(60, 'Preparing image...');
      const bytes = dataUrlToBytes(images[0].dataUrl);
      const resultBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      emitProgress(100, 'Image ready.');
      const result: ProcessedPdfResult = {
        fileName: `${cleanBaseName}.jpg`,
        buffer: resultBuffer,
        size: resultBuffer.byteLength,
      };
      const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
        type: 'RESPONSE',
        payload: { id, success: true, data: result },
      };
      (self as any).postMessage(responseMsg, [resultBuffer]);
      return;
    }

    emitProgress(50, `Packaging ${images.length} images into a ZIP...`);
    const pad = String(images.length).length;
    const entries = images.map((img) => ({
      name: `${cleanBaseName}_page_${String(img.pageNumber).padStart(pad, '0')}.jpg`,
      data: dataUrlToBytes(img.dataUrl),
    }));
    const zipBytes = createZip(entries);
    const resultBuffer = zipBytes.buffer.slice(
      zipBytes.byteOffset,
      zipBytes.byteOffset + zipBytes.byteLength
    ) as ArrayBuffer;

    emitProgress(100, 'ZIP ready.');
    const result: ProcessedPdfResult = {
      fileName: `${cleanBaseName}_pages.zip`,
      buffer: resultBuffer,
      size: resultBuffer.byteLength,
      pageCount: images.length,
    };
    const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
      type: 'RESPONSE',
      payload: { id, success: true, data: result },
    };
    (self as any).postMessage(responseMsg, [resultBuffer]);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : 'Failed to export images';
    const responseMsg: WorkerIncomingMessage = {
      type: 'RESPONSE',
      payload: { id, success: false, error: errorMsg },
    };
    self.postMessage(responseMsg);
  }
});
