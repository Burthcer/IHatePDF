/**
 * Watermark PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Stamps text or an image onto pages — once at a chosen position, or tiled
 * across the whole page — positioned relative to the page as displayed
 * (rotation and crop respected). Any script works for text (non-Latin text
 * falls back to an embedded Unicode font). "Below content" moves the stamp's
 * content stream in front of the page's own.
 */

import { rgb, degrees, PDFName, PDFArray, PDFRef, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { openPdf } from '../../services/pdfLoader';
import { fontForText } from '../../services/fonts';
import { withViewerFrame } from '../../services/pageOverlay';
import { hexToRgb01, rotatedPlacement } from '../../services/pdfStampPosition';
import { parsePageRanges, rangesToPages } from '../../services/pageRanges';
import type { WorkerRequest, WatermarkPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

function moveLastStreamToFront(page: PDFPage): void {
  const contents = page.node.get(PDFName.of('Contents'));
  const arr = page.node.context.lookup(contents);
  if (!(arr instanceof PDFArray) || arr.size() < 2) return;
  const last = arr.get(arr.size() - 1);
  if (!(last instanceof PDFRef)) return;
  arr.remove(arr.size() - 1);
  arr.insert(0, last);
}

export async function applyWatermark(
  payload: WatermarkPayload,
  onProgress?: (progress: number, stage: string) => void
): Promise<ProcessedPdfResult> {
  const { fileBuffer, fileName, mode, text, imageBytes, imageType, fontSize, color, opacity, rotationDegrees, position, layer } = payload;
  if (!fileBuffer) throw new Error('No PDF buffer provided.');
  if (mode === 'text' && (!text || text.trim().length === 0)) throw new Error('Watermark text is required.');
  if (mode === 'image' && !imageBytes) throw new Error('Watermark image is required.');

  onProgress?.(10, 'Loading PDF document...');
  const pdfDoc = await openPdf(fileBuffer);
  const pages = pdfDoc.getPages();
  const targets = payload.pages ? new Set(rangesToPages(parsePageRanges(payload.pages, pages.length)).map((p) => p - 1)) : null;

  let font: PDFFont | null = null;
  let image: PDFImage | null = null;
  const { r, g, b } = hexToRgb01(color);
  const lines = (text ?? '').split('\n');

  if (mode === 'text') {
    font = await fontForText(pdfDoc, { family: payload.fontFamily ?? 'sans', bold: payload.bold ?? true, italic: false }, text!);
  } else {
    onProgress?.(20, 'Embedding watermark image...');
    image = imageType === 'jpg' ? await pdfDoc.embedJpg(new Uint8Array(imageBytes!)) : await pdfDoc.embedPng(new Uint8Array(imageBytes!));
  }

  onProgress?.(35, 'Stamping pages...');
  pages.forEach((page, i) => {
    if (targets && !targets.has(i)) return;
    withViewerFrame(page, ({ width: pw, height: ph }) => {
      let w: number;
      let h: number;
      if (font) {
        w = Math.max(...lines.map((l) => font!.widthOfTextAtSize(l, fontSize)));
        h = fontSize * 1.15 * lines.length;
      } else {
        const scale = ((payload.imageScale ?? 0.5) * pw) / image!.width;
        w = image!.width * scale;
        h = image!.height * scale;
      }

      const drawAt = (x: number, y: number) => {
        if (font) {
          lines.forEach((line, li) => {
            // each line offset downward within the rotated box
            const t = (rotationDegrees * Math.PI) / 180;
            const dy = (lines.length - 1 - li) * fontSize * 1.15 + fontSize * 0.2;
            page.drawText(line, {
              x: x - dy * Math.sin(t),
              y: y + dy * Math.cos(t),
              size: fontSize,
              font: font!,
              color: rgb(r, g, b),
              opacity,
              rotate: degrees(rotationDegrees),
            });
          });
        } else {
          page.drawImage(image!, { x, y, width: w, height: h, opacity, rotate: degrees(rotationDegrees) });
        }
      };

      if (payload.tile) {
        const t = (rotationDegrees * Math.PI) / 180;
        const bw = Math.abs(w * Math.cos(t)) + Math.abs(h * Math.sin(t));
        const bh = Math.abs(w * Math.sin(t)) + Math.abs(h * Math.cos(t));
        const stepX = bw + Math.max(40, bw * 0.4);
        const stepY = bh + Math.max(60, bh * 0.8);
        for (let row = 0, cy = ph - stepY / 2; cy > -stepY; cy -= stepY, row++) {
          for (let cx = (row % 2 ? stepX / 2 : 0) + stepX / 2 - stepX; cx < pw + stepX; cx += stepX) {
            drawAt(cx - ((w / 2) * Math.cos(t) - (h / 2) * Math.sin(t)), cy - ((w / 2) * Math.sin(t) + (h / 2) * Math.cos(t)));
          }
        }
      } else {
        const { x, y } = rotatedPlacement(pw, ph, w, h, rotationDegrees, position, 24);
        drawAt(x, y);
      }
    });
    if (layer === 'below') moveLastStreamToFront(page);
    if (pages.length > 1) onProgress?.(35 + Math.round((i / pages.length) * 50), `Stamping page ${i + 1} of ${pages.length}...`);
  });

  onProgress?.(90, 'Saving document...');
  const outBytes = await pdfDoc.save({ useObjectStreams: true });
  const resultBuffer = outBytes.buffer.slice(outBytes.byteOffset, outBytes.byteOffset + outBytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Watermark applied.');
  return {
    fileName: `${fileName.replace(/\.[^/.]+$/, '')}_watermarked.pdf`,
    buffer: resultBuffer,
    size: resultBuffer.byteLength,
    pageCount: pages.length,
  };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  (self as any).addEventListener('message', async (event: MessageEvent<WorkerRequest<WatermarkPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'WATERMARK_PDF') return;
    try {
      const result = await applyWatermark(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        (self as any).postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to watermark PDF document' } });
    }
  });
}
