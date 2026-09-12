/**
 * Watermark PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps text or an image onto every page. pdf-lib's drawing methods always
 * *append* to a page's content stream (drawn on top of existing content) —
 * there's no high-level "draw behind" primitive. "Below content" mode is a
 * best-effort reorder of the page's /Contents array after drawing (moving
 * the newly-appended stream to the front), done defensively: if the
 * document's Contents structure doesn't match the expected "grew by one
 * entry" shape, it's left as "above content" rather than risk corrupting
 * the page.
 */

import { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import { hexToRgb01, computeAnchor } from '../../services/pdfStampPosition';
import type {
  WorkerRequest,
  WatermarkPayload,
  ProcessedPdfResult,
  WorkerIncomingMessage,
} from '../../types/worker';

function moveWatermarkBehindContent(page: import('pdf-lib').PDFPage): void {
  try {
    const contentsKey = PDFName.of('Contents');
    const contents = page.node.get(contentsKey);
    if (!(contents instanceof PDFArray) || contents.size() < 2) return;

    const lastIdx = contents.size() - 1;
    const lastRef = contents.get(lastIdx);
    if (!(lastRef instanceof PDFRef)) return;

    contents.remove(lastIdx);
    contents.insert(0, lastRef);
  } catch {
    // Leave as "above content" — safer than a half-applied reorder.
  }
}

export async function applyWatermark(
  payload: WatermarkPayload,
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  const {
    fileBuffer,
    fileName,
    mode,
    text,
    imageBytes,
    imageType,
    fontSize,
    color,
    opacity,
    rotationDegrees,
    position,
    layer,
  } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided.');
  if (mode === 'text' && (!text || text.trim().length === 0)) {
    throw new Error('Watermark text is required.');
  }
  if (mode === 'image' && !imageBytes) {
    throw new Error('Watermark image is required.');
  }

  onProgress?.(10, 'Loading PDF document...');
  const pdfDoc = await PDFDocument.load(fileBuffer);
  const pages = pdfDoc.getPages();

  let font: import('pdf-lib').PDFFont | null = null;
  let embeddedImage: import('pdf-lib').PDFImage | null = null;
  const { r, g, b } = hexToRgb01(color);

  if (mode === 'text') {
    font = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  } else {
    onProgress?.(20, 'Embedding watermark image...');
    embeddedImage =
      imageType === 'jpg'
        ? await pdfDoc.embedJpg(new Uint8Array(imageBytes!))
        : await pdfDoc.embedPng(new Uint8Array(imageBytes!));
  }

  onProgress?.(35, 'Stamping watermark onto pages...');
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();

    if (mode === 'text' && font) {
      const contentWidth = font.widthOfTextAtSize(text!, fontSize);
      const contentHeight = font.heightAtSize(fontSize);
      const { x, y } = computeAnchor(pageWidth, pageHeight, contentWidth, contentHeight, position, 24);

      page.drawText(text!, {
        x,
        y,
        size: fontSize,
        font,
        color: rgb(r, g, b),
        opacity,
        rotate: degrees(rotationDegrees),
      });
    } else if (embeddedImage) {
      const scale = Math.min((pageWidth * 0.5) / embeddedImage.width, (pageHeight * 0.5) / embeddedImage.height, 1);
      const contentWidth = embeddedImage.width * scale;
      const contentHeight = embeddedImage.height * scale;
      const { x, y } = computeAnchor(pageWidth, pageHeight, contentWidth, contentHeight, position, 24);

      page.drawImage(embeddedImage, {
        x,
        y,
        width: contentWidth,
        height: contentHeight,
        opacity,
        rotate: degrees(rotationDegrees),
      });
    }

    if (layer === 'below') {
      moveWatermarkBehindContent(page);
    }

    if (pages.length > 1) {
      onProgress?.(35 + Math.round((i / pages.length) * 50), `Stamping page ${i + 1} of ${pages.length}...`);
    }
  }

  onProgress?.(90, 'Saving watermarked document...');
  const outBytes = await pdfDoc.save();
  const resultBuffer = outBytes.buffer.slice(
    outBytes.byteOffset,
    outBytes.byteOffset + outBytes.byteLength
  ) as ArrayBuffer;

  onProgress?.(100, 'Watermark applied successfully.');

  const cleanBaseName = fileName.replace(/\.[^/.]+$/, '');
  return {
    fileName: `${cleanBaseName}_watermarked.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: pages.length,
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener(
    'message',
    async (event: MessageEvent<WorkerRequest<WatermarkPayload>>) => {
      const { id, action, payload } = event.data;
      if (action !== 'WATERMARK_PDF') return;

      try {
        const result = await applyWatermark(payload, (progress, stage) => {
          const msg: WorkerIncomingMessage = {
            type: 'PROGRESS',
            payload: { id, progress, stage },
          };
          (self as any).postMessage(msg);
        });

        const responseMsg: WorkerIncomingMessage<ProcessedPdfResult> = {
          type: 'RESPONSE',
          payload: { id, success: true, data: result },
        };
        (self as any).postMessage(responseMsg, [result.buffer]);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Failed to watermark PDF document';
        const responseMsg: WorkerIncomingMessage = {
          type: 'RESPONSE',
          payload: { id, success: false, error: errorMsg },
        };
        (self as any).postMessage(responseMsg);
      }
    }
  );
}
