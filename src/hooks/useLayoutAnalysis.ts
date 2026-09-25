import { useEffect, useState } from 'react';
import { openPdfJsDocument } from '../services/pdfWorkerSetup';
import { memoryManager } from '../services/memoryManager';
import { analyzeDocumentLayout, type PageLayout } from '../services/textLayout';

/** Runs the structure analysis for a PDF (in the background) and exposes progress. */
export function useLayoutAnalysis(buffer: ArrayBuffer | null | undefined) {
  const [pages, setPages] = useState<PageLayout[] | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPages(null);
    setError(null);
    setProgress(null);
    if (!buffer) return;
    let cancelled = false;
    const task = openPdfJsDocument(buffer);
    task.promise
      .then(async (doc) => {
        try {
          const result = await analyzeDocumentLayout(doc, (done, total) => !cancelled && setProgress({ done, total }));
          if (!cancelled) setPages(result);
        } finally {
          await memoryManager.destroyPdfDocument(doc);
        }
      })
      .catch((err) => !cancelled && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      cancelled = true;
    };
  }, [buffer]);

  const hasText = !!pages && pages.some((p) => p.lines.length > 0);
  return { pages, progress, error, hasText };
}
