import { useEffect, useState } from 'react';
import { openPdfJsDocument } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';
import { analyzeDocumentLayout, type PageLayout } from '../services/textLayout';
import { analyzeDocumentLayoutNative } from '../services/textLayoutNative';

/** Runs the structure analysis for a PDF (in the background) and exposes progress. */
export function useLayoutAnalysis(buffer: Blob | ArrayBuffer | null | undefined) {
  const [pages, setPages] = useState<PageLayout[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPages(null);
    setError(null);
    setProgress(null);
    if (!buffer) return;
    let cancelled = false;
    const onProgress = (done: number, total: number) => !cancelled && setProgress({ done, total });
    (async () => {
      // Desktop app: PDFium reads the text (pdf.js isn't even loaded); null means "use pdf.js".
      const native = await analyzeDocumentLayoutNative(buffer, onProgress);
      if (cancelled) return;
      if (native) return setPages(native);
      const task = openPdfJsDocument(buffer);
      try {
        const doc = await task.promise;
        try {
          const result = await analyzeDocumentLayout(doc, onProgress);
          if (!cancelled) setPages(result);
        } finally {
          await memoryManager.destroyPdfDocument(doc);
        }
      } catch (err) {
        void task.destroy();
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buffer]);

  const hasText = !!pages && pages.some((p) => p.lines.length > 0);
  return { pages, progress, error, hasText };
}
