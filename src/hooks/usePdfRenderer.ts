/**
 * One-off page rendering with pdf.js (cover thumbnails, single-page
 * previews). Whole-document thumbnail grids use usePageThumbnails instead.
 */

import { hasNative, stageInput } from '../services/nativeWorker';
import { useCallback } from 'react';
import { memoryManager } from '../services/memoryManager';

export function usePdfRenderer() {
  /** Renders page `pageNumber` (1-based) at `targetWidth` pixels wide and returns a JPEG data URL. */
  const renderThumbnail = useCallback(async (pdf: Blob | ArrayBuffer, pageNumber: number, targetWidth = 200): Promise<string> => {
    // Desktop app: PDFium draws the page (no pdf.js load, no canvas).
    if (hasNative()) {
      try {
        const path = await stageInput(pdf);
        const bytes: ArrayBuffer = await (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__.core.invoke('render_thumb', { path, index: pageNumber - 1, width: Math.ceil(targetWidth), quality: 0.85 });
        return await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result));
          r.onerror = () => reject(r.error);
          r.readAsDataURL(new Blob([bytes], { type: 'image/jpeg' }));
        });
      } catch (err) {
        console.warn('PDFium preview failed, using pdf.js:', err);
      }
    }
    const { openPdfJsDocument } = await import('../services/pdfWorkerSetup'); // loaded on first use
    const doc = await openPdfJsDocument(pdf).promise;
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
