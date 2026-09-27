/**
 * One-off page rendering with pdf.js (cover thumbnails, single-page
 * previews). Whole-document thumbnail grids use usePageThumbnails instead.
 */

import { useCallback } from 'react';
import { memoryManager } from '../services/memoryManager';

export function usePdfRenderer() {
  /** Renders page `pageNumber` (1-based) at `targetWidth` pixels wide and returns a JPEG data URL. */
  const renderThumbnail = useCallback(async (pdfBuffer: ArrayBuffer, pageNumber: number, targetWidth = 200): Promise<string> => {
    const { openPdfJsDocument } = await import('../services/pdfWorkerSetup'); // loaded on first use
    const doc = await openPdfJsDocument(pdfBuffer).promise;
    try {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: targetWidth / page.getViewport({ scale: 1 }).width });
      const canvas = memoryManager.acquireCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      try {
        const ctx = canvas.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        return canvas.toDataURL('image/jpeg', 0.85);
      } finally {
        memoryManager.releaseCanvas(canvas);
        page.cleanup();
      }
    } finally {
      await memoryManager.destroyPdfDocument(doc);
    }
  }, []);

  return { renderThumbnail };
}
