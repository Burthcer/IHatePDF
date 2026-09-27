/**
 * HTML to PDF Web Worker
 * IHatePDF - 100% Client-Side Architecture
 *
 * Draws the display list captured from the browser's layout (see
 * captureLayout.ts): backgrounds, borders, images and every word at its
 * laid-out position, as real PDF text in the matching font family, weight,
 * style and color.
 */

import { PDFDocument, rgb, LineCapStyle, type PDFFont } from 'pdf-lib';
import { fontForText, type FontFamily } from '../../services/fonts';
import type { WorkerRequest, HtmlToPdfPayload, ProcessedPdfResult, WorkerIncomingMessage } from '../../types/worker';

function color(hex: string) {
  const n = parseInt(hex.replace('#', ''), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

export async function htmlToPdf(payload: HtmlToPdfPayload, onProgress?: (p: number, s: string) => void): Promise<ProcessedPdfResult> {
  const { pages, images, pageWidthPt: W, pageHeightPt: H, fileName, title } = payload;
  const doc = await PDFDocument.create();
  if (title) doc.setTitle(title);

  onProgress?.(10, 'Preparing fonts...');
  const textByStyle = new Map<string, string>();
  for (const p of pages) for (const it of p.items) if (it.t === 'text') {
    const key = `${it.family}|${it.bold}|${it.italic}`;
    textByStyle.set(key, (textByStyle.get(key) ?? '') + it.text);
  }
  const fonts = new Map<string, PDFFont>();
  for (const [key, text] of textByStyle) {
    const [family, bold, italic] = key.split('|');
    fonts.set(key, await fontForText(doc, { family: family as FontFamily, bold: bold === 'true', italic: italic === 'true' }, [...new Set(text)].join('')));
  }
  const embedded = await Promise.all(images.map((b) => doc.embedPng(new Uint8Array(b)).catch(() => null)));

  pages.forEach((pageData, pi) => {
    onProgress?.(20 + Math.round((pi / pages.length) * 70), `Drawing page ${pi + 1} of ${pages.length}...`);
    const page = doc.addPage([W, H]);
    for (const it of pageData.items) {
      switch (it.t) {
        case 'rect':
          if (it.w > 0 && it.h > 0) page.drawRectangle({ x: it.x, y: H - it.y - it.h, width: it.w, height: it.h, color: color(it.fill), opacity: it.opacity });
          break;
        case 'line':
          page.drawLine({ start: { x: it.x1, y: H - it.y1 }, end: { x: it.x2, y: H - it.y2 }, thickness: it.width, color: color(it.color), dashArray: it.dashed ? [it.width * 3, it.width * 2] : undefined, lineCap: LineCapStyle.Butt });
          break;
        case 'image': {
          const img = embedded[it.index];
          if (img) page.drawImage(img, { x: it.x, y: H - it.y - it.h, width: it.w, height: it.h });
          break;
        }
        case 'text': {
          const font = fonts.get(`${it.family}|${it.bold}|${it.italic}`)!;
          page.drawText(it.text, { x: it.x, y: H - it.y, size: it.size, font, color: color(it.color) });
          break;
        }
      }
    }
  });

  onProgress?.(95, 'Saving PDF...');
  const bytes = await doc.save({ useObjectStreams: true });
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  onProgress?.(100, 'Done.');
  return { fileName: `${fileName.replace(/\.[^/.]+$/, '') || 'document'}.pdf`, buffer, size: buffer.byteLength, pageCount: pages.length };
}

if (typeof self !== 'undefined' && typeof (self as any).addEventListener === 'function') {
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<HtmlToPdfPayload>>) => {
    const { id, action, payload } = event.data;
    if (action !== 'HTML_TO_PDF') return;
    try {
      const result = await htmlToPdf(payload, (progress, stage) => {
        const msg: WorkerIncomingMessage = { type: 'PROGRESS', payload: { id, progress, stage } };
        self.postMessage(msg);
      });
      (self as any).postMessage({ type: 'RESPONSE', payload: { id, success: true, data: result } }, [result.buffer]);
    } catch (err) {
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: err instanceof Error ? err.message : 'Failed to convert HTML to PDF' } });
    }
  });
}
