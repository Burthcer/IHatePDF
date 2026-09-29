/**
 * JPG/PNG to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Embeds each image as its own page via pdf-lib, scaled to fit within the
 * chosen page size and margins while preserving aspect ratio. JPEGs are
 * copied from the picked files as the PDF is written, never held in memory.
 */

import { PDFDocument } from 'pdf-lib';
import type { ImagesToPdfPayload, ProcessedPdfResult } from '../../types/worker';
import { drawImageAt, embedJpegSource, type EmbeddedImage } from '../../services/lazyImage';
import { emitPdf } from '../../services/workerEmit';
import { serveTask } from '../../services/workerTask';
import type { OutputSink } from '../../services/workerOutput';

const A4 = { width: 595.28, height: 841.89 };
const LETTER = { width: 612, height: 792 };
const MARGINS = { none: 0, small: 18, big: 54 };

export async function imagesToPdf(
  payload: ImagesToPdfPayload,
  onProgress?: (progress: number, stage: string) => void,
  sink?: OutputSink
): Promise<ProcessedPdfResult> {
  const { images, orientation, margin, pageSize, fileName } = payload;
  if (!images || images.length === 0) throw new Error('No images provided.');

  onProgress?.(10, 'Creating document...');
  const pdfDoc = await PDFDocument.create();
  const marginPt = MARGINS[margin];

  for (let i = 0; i < images.length; i++) {
    const { bytes, type } = images[i];
    let embedded: EmbeddedImage;
    if (type === 'jpg') {
      embedded = await embedJpegSource(pdfDoc, bytes);
    } else {
      const png = await pdfDoc.embedPng(new Uint8Array(bytes instanceof Blob ? await bytes.arrayBuffer() : bytes));
      embedded = { ref: png.ref, width: png.width, height: png.height };
    }
    const imgIsLandscape = embedded.width > embedded.height;

    let baseSize: { width: number; height: number };
    if (pageSize === 'fit') {
      // Page shaped like the image; big photos are scaled so the long edge is
      // A4's long edge instead of producing a multi-metre page.
      const k = Math.min(1, A4.height / Math.max(embedded.width, embedded.height));
      baseSize = { width: embedded.width * k + marginPt * 2, height: embedded.height * k + marginPt * 2 };
    } else {
      baseSize = pageSize === 'letter' ? { ...LETTER } : { ...A4 };
      const wantLandscape = orientation === 'landscape' || (orientation === 'auto' && imgIsLandscape);
      if (wantLandscape) baseSize = { width: baseSize.height, height: baseSize.width };
    }

    const page = pdfDoc.addPage([baseSize.width, baseSize.height]);
    const availW = baseSize.width - marginPt * 2;
    const availH = baseSize.height - marginPt * 2;
    const scale = pageSize === 'fit' ? Math.min(availW / embedded.width, availH / embedded.height) : Math.min(availW / embedded.width, availH / embedded.height, 1);
    const drawW = embedded.width * scale;
    const drawH = embedded.height * scale;
    const x = (baseSize.width - drawW) / 2;
    const y = (baseSize.height - drawH) / 2;

    drawImageAt(page, embedded, x, y, drawW, drawH);
    onProgress?.(10 + Math.round(((i + 1) / images.length) * 75), `Adding image ${i + 1}/${images.length}...`);
  }

  onProgress?.(90, 'Saving PDF...');
  const out = await emitPdf(pdfDoc, sink);

  onProgress?.(100, 'PDF ready.');
  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '') || 'images';
  return {
    fileName: `${cleanBaseName}.pdf`,
    ...out,
    pageCount: images.length,
  };
}

serveTask<ImagesToPdfPayload, ProcessedPdfResult>('IMAGES_TO_PDF', (p, ctx) => imagesToPdf(p, ctx.progress, ctx.sink()), 'Failed to build PDF from images');
