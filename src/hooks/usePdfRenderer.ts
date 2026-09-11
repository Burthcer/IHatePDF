/**
 * PDF Rendering & Thumbnail Generation Hook
 * IHatePDF - 100% Client-Side Architecture
 *
 * Provides page rasterization, thumbnail generation, and metadata extraction
 * using local pdfjs-dist worker with strict canvas memory pooling.
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { pdfjsLib } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';
import type { PDFPagePreview } from '../types/pdf';
import type { ExtractedPageText, PptxSlideImage } from '../types/worker';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Groups pdf.js text items into paragraphs using vertical-gap heuristics:
 * a small Y jump between items is a line wrap (same paragraph), a large one
 * is a paragraph break. Works well for typical single-column documents;
 * multi-column layouts and tables aren't specially handled.
 */
function groupTextItemsIntoParagraphs(items: Array<{ str: string; transform: number[]; height: number }>): string[] {
  const paragraphs: string[] = [];
  let current = '';
  let prevY: number | null = null;

  for (const item of items) {
    if (item.str === '') continue;
    const y = item.transform[5];
    const h = item.height || 10;

    if (prevY === null) {
      current = item.str;
    } else {
      const gap = Math.abs(prevY - y);
      if (gap > h * 1.6) {
        if (current.trim()) paragraphs.push(current.trim());
        current = item.str;
      } else if (gap > h * 0.3) {
        current += ' ' + item.str;
      } else {
        current += item.str;
      }
    }
    prevY = y;
  }
  if (current.trim()) paragraphs.push(current.trim());
  return paragraphs;
}

/**
 * Groups pdf.js text items into rows (by Y) and cells within each row (by
 * X-gaps), for PDF -> Excel. Real table structure isn't present in raw PDF
 * content streams, so this is a positional heuristic — works reasonably for
 * simple single-column tables, not guaranteed for complex/nested layouts.
 */
function groupTextItemsIntoRows(
  items: Array<{ str: string; transform: number[]; height: number; width: number }>
): string[][] {
  interface RowAcc {
    y: number;
    cells: Array<{ x: number; str: string; width: number }>;
  }
  const rows: RowAcc[] = [];

  for (const item of items) {
    if (!item.str.trim()) continue;
    const y = item.transform[5];
    const x = item.transform[4];
    const h = item.height || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < h * 0.5);
    if (!row) {
      row = { y, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, str: item.str, width: item.width });
  }

  rows.sort((a, b) => b.y - a.y); // PDF y increases upward; want top-to-bottom

  return rows.map((row) => {
    row.cells.sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    let current = '';
    let prevEndX: number | null = null;
    for (const cell of row.cells) {
      const gap = prevEndX === null ? 0 : cell.x - prevEndX;
      if (prevEndX !== null && gap > 10) {
        cells.push(current.trim());
        current = cell.str;
      } else {
        current += cell.str;
      }
      prevEndX = cell.x + cell.width;
    }
    if (current.trim()) cells.push(current.trim());
    return cells;
  });
}

export interface UsePdfRendererOptions {
  thumbnailScale?: number;
  maxInitialPages?: number;
}

// ponytail: caps how many pages render concurrently so a 500-page PDF doesn't
// freeze the main thread with simultaneous canvas/WASM work. Raise if profiling
// shows headroom, or move to a Web Worker pool if rendering still stutters.
const MAX_CONCURRENT_RENDERS = 3;

export function usePdfRenderer(options: UsePdfRendererOptions = {}) {
  const { thumbnailScale = 0.35, maxInitialPages = 10 } = options;
  const [isRendering, setIsRendering] = useState<boolean>(false);
  const [renderProgress, setRenderProgress] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);

  const activeDocumentsRef = useRef<PDFDocumentProxy[]>([]);

  // Cleanup documents on unmount
  useEffect(() => {
    return () => {
      activeDocumentsRef.current.forEach((doc) => {
        memoryManager.destroyPdfDocument(doc);
      });
      activeDocumentsRef.current = [];
    };
  }, []);

  /**
   * Loads a PDFDocumentProxy from an ArrayBuffer.
   */
  const loadDocument = useCallback(async (buffer: ArrayBuffer): Promise<PDFDocumentProxy> => {
    try {
      // Create a slice copy so the buffer can be safely accessed without detaching if reused
      const bufferCopy = buffer.slice(0);
      const loadingTask = pdfjsLib.getDocument({
        data: new Uint8Array(bufferCopy),
        useSystemFonts: true,
      });

      const doc = await loadingTask.promise;
      activeDocumentsRef.current.push(doc);
      return doc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to load PDF document';
      throw new Error(msg);
    }
  }, []);

  /**
   * Renders a single page to a canvas and exports as a data URL.
   */
  const renderPage = useCallback(
    async (
      doc: PDFDocumentProxy,
      pageNumber: number,
      scale: number = thumbnailScale
    ): Promise<PDFPagePreview> => {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale });

      const canvas = memoryManager.acquireCanvas(
        Math.floor(viewport.width),
        Math.floor(viewport.height)
      );

      const ctx = canvas.getContext('2d', { alpha: false });
      if (!ctx) {
        memoryManager.releaseCanvas(canvas);
        throw new Error('Failed to create canvas 2D rendering context.');
      }

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const renderContext = {
        canvasContext: ctx,
        viewport,
        canvas,
      };

      try {
        await page.render(renderContext).promise;
        // JPEG, not WEBP: several call sites (PDF -> JPG export, PDF -> PPTX
        // slide images, Redact's rebuilt pages) feed these bytes straight
        // into pdf-lib's embedJpg or write them out as .jpg files, and
        // WEBP-encoded bytes under a .jpg name/extension would silently fail
        // to decode there even though <img> tags render WEBP fine.
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);

        return {
          pageNumber,
          dataUrl,
          width: viewport.width,
          height: viewport.height,
          rotation: page.rotate,
        };
      } finally {
        // Return canvas to pool and release bitmap memory
        memoryManager.releaseCanvas(canvas);
      }
    },
    [thumbnailScale]
  );

  /**
   * Generates thumbnail previews for an ArrayBuffer.
   */
  const renderThumbnails = useCallback(
    async (
      buffer: ArrayBuffer,
      pageLimit: number = maxInitialPages
    ): Promise<{ previews: PDFPagePreview[]; totalPages: number }> => {
      setIsRendering(true);
      setRenderProgress(0);
      setError(null);

      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(buffer);
        const totalPages = doc.numPages;
        const countToRender = Math.min(totalPages, pageLimit);
        const previews: PDFPagePreview[] = [];

        for (let i = 1; i <= countToRender; i++) {
          const preview = await renderPage(doc, i);
          previews.push(preview);
          setRenderProgress(Math.round((i / countToRender) * 100));
        }

        return { previews, totalPages };
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error rendering PDF thumbnails';
        setError(msg);
        throw err;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
        setIsRendering(false);
      }
    },
    [loadDocument, maxInitialPages, renderPage]
  );

  /**
   * Renders a single page thumbnail scaled to a target pixel width, opening
   * and destroying its own document. Use for one-off previews (e.g. a file's
   * cover thumbnail); prefer renderAllThumbnails for a whole document so the
   * PDFDocumentProxy is only opened once.
   */
  const renderThumbnail = useCallback(
    async (
      pdfBuffer: ArrayBuffer,
      pageNumber: number,
      targetWidth: number = 200
    ): Promise<string> => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(pdfBuffer);
        const page = await doc.getPage(pageNumber);
        const unscaledWidth = page.getViewport({ scale: 1 }).width;
        const preview = await renderPage(doc, pageNumber, targetWidth / unscaledWidth);
        return preview.dataUrl;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
      }
    },
    [loadDocument, renderPage]
  );

  /**
   * Renders every page of a document as a thumbnail grid preview, throttled
   * to MAX_CONCURRENT_RENDERS pages in flight at once so batch rendering
   * doesn't lock up the UI thread.
   */
  const renderAllThumbnails = useCallback(
    async (
      pdfBuffer: ArrayBuffer,
      onProgress?: (current: number, total: number) => void
    ): Promise<PDFPagePreview[]> => {
      setIsRendering(true);
      setError(null);

      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(pdfBuffer);
        const total = doc.numPages;
        const results: PDFPagePreview[] = new Array(total);
        let nextPageNumber = 1;
        let completed = 0;

        const renderNext = async (): Promise<void> => {
          while (nextPageNumber <= total) {
            const pageNumber = nextPageNumber++;
            const preview = await renderPage(doc!, pageNumber);
            results[pageNumber - 1] = preview;
            completed++;
            onProgress?.(completed, total);
          }
        };

        const workerCount = Math.min(MAX_CONCURRENT_RENDERS, total);
        await Promise.all(Array.from({ length: workerCount }, renderNext));

        return results;
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Error rendering PDF thumbnails';
        setError(msg);
        throw err;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
        setIsRendering(false);
      }
    },
    [loadDocument, renderPage]
  );

  /**
   * Extracts text from every page, grouped into paragraphs, for PDF -> Word.
   */
  const extractAllText = useCallback(
    async (
      pdfBuffer: ArrayBuffer,
      onProgress?: (current: number, total: number) => void
    ): Promise<ExtractedPageText[]> => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(pdfBuffer);
        const total = doc.numPages;
        const pages: ExtractedPageText[] = [];

        for (let i = 1; i <= total; i++) {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(
            (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
          );
          const paragraphs = groupTextItemsIntoParagraphs(items);
          pages.push({ pageNumber: i, paragraphs });
          onProgress?.(i, total);
        }

        return pages;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
      }
    },
    [loadDocument]
  );

  /**
   * Extracts a row/cell table structure from every page, for PDF -> Excel.
   */
  const extractAllTables = useCallback(
    async (
      pdfBuffer: ArrayBuffer,
      onProgress?: (current: number, total: number) => void
    ): Promise<Array<{ pageNumber: number; rows: string[][] }>> => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(pdfBuffer);
        const total = doc.numPages;
        const pages: Array<{ pageNumber: number; rows: string[][] }> = [];

        for (let i = 1; i <= total; i++) {
          const page = await doc.getPage(i);
          const textContent = await page.getTextContent();
          const items = textContent.items.filter(
            (item): item is import('pdfjs-dist/types/src/display/api').TextItem => 'str' in item
          );
          const rows = groupTextItemsIntoRows(items);
          pages.push({ pageNumber: i, rows });
          onProgress?.(i, total);
        }

        return pages;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
      }
    },
    [loadDocument]
  );

  /**
   * Renders every page at a target pixel width (full resolution, not a
   * thumbnail) for PDF -> PPTX, where each page becomes one slide image.
   */
  const renderAllPageImages = useCallback(
    async (
      pdfBuffer: ArrayBuffer,
      targetWidth: number = 1280,
      onProgress?: (current: number, total: number) => void
    ): Promise<PptxSlideImage[]> => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(pdfBuffer);
        const total = doc.numPages;
        const slides: PptxSlideImage[] = [];

        for (let i = 1; i <= total; i++) {
          const page = await doc.getPage(i);
          const unscaledViewport = page.getViewport({ scale: 1 });
          const scale = targetWidth / unscaledViewport.width;
          const preview = await renderPage(doc, i, scale);
          slides.push({
            dataUrl: preview.dataUrl,
            widthPt: unscaledViewport.width,
            heightPt: unscaledViewport.height,
          });
          onProgress?.(i, total);
        }

        return slides;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
      }
    },
    [loadDocument, renderPage]
  );

  /**
   * Retrieves page count without full rendering.
   */
  const getPageCount = useCallback(
    async (buffer: ArrayBuffer): Promise<number> => {
      let doc: PDFDocumentProxy | null = null;
      try {
        doc = await loadDocument(buffer);
        return doc.numPages;
      } finally {
        if (doc) {
          await memoryManager.destroyPdfDocument(doc);
          activeDocumentsRef.current = activeDocumentsRef.current.filter((d) => d !== doc);
        }
      }
    },
    [loadDocument]
  );

  return {
    renderThumbnail,
    renderAllThumbnails,
    renderThumbnails,
    renderPage,
    extractAllText,
    extractAllTables,
    renderAllPageImages,
    getPageCount,
    loadDocument,
    isRendering,
    isLoading: isRendering,
    renderProgress,
    error,
  };
}
