/**
 * Renders small thumbnails for every page of a document, progressively
 * (a couple at a time) so large files show their first pages immediately.
 */

import { useEffect, useState } from 'react';
import { openPdfJsDocument } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';

export interface PageThumbInfo {
  url?: string;
  /** Displayed size in points (after /Rotate). */
  width: number;
  height: number;
  rotation: number;
}

export function usePageThumbnails(buffer: ArrayBuffer | null | undefined, targetWidth = 160) {
  const [pages, setPages] = useState<PageThumbInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    setPages([]);
    setError(null);
    setDone(false);
    if (!buffer || buffer.byteLength === 0) return;
    let cancelled = false;
    const task = openPdfJsDocument(buffer);

    (async () => {
      try {
        const doc = await task.promise;
        const info: PageThumbInfo[] = [];
        for (let i = 1; i <= doc.numPages; i++) {
          const page = await doc.getPage(i);
          const vp = page.getViewport({ scale: 1 });
          info.push({ width: vp.width, height: vp.height, rotation: page.rotate });
        }
        if (cancelled) return;
        setPages(info.map((p) => ({ ...p })));

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        let next = 0;
        const worker = async () => {
          while (!cancelled && next < doc.numPages) {
            const i = next++;
            const page = await doc.getPage(i + 1);
            const vp = page.getViewport({ scale: (targetWidth * dpr) / info[i].width });
            const canvas = memoryManager.acquireCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
            const ctx = canvas.getContext('2d', { alpha: false })!;
            ctx.fillStyle = '#fff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            try {
              await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
              const url = canvas.toDataURL('image/jpeg', 0.75);
              if (!cancelled) setPages((prev) => prev.map((p, k) => (k === i ? { ...p, url } : p)));
            } catch {
              // leave this thumbnail blank
            } finally {
              memoryManager.releaseCanvas(canvas);
              page.cleanup();
            }
          }
        };
        await Promise.all([worker(), worker()]);
        if (!cancelled) setDone(true);
        await memoryManager.destroyPdfDocument(doc);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [buffer, targetWidth]);

  return { pages, error, done };
}
