import React, { useEffect, useState } from 'react';
import { FileText, Trash2, Loader2, AlertCircle, ArrowRight } from 'lucide-react';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import type { PDFFile, PDFPagePreview } from '../../types/pdf';

// ponytail: caps rendered pages per file so a huge PDF doesn't stall this
// verification step; raise or add pagination/virtualization if users need
// to review every page of very large documents.
const MAX_PREVIEW_PAGES = 30;

interface PdfPreviewGridProps {
  files: PDFFile[];
  onReset: () => void;
  onContinue: () => void;
}

export const PdfPreviewGrid: React.FC<PdfPreviewGridProps> = ({ files, onReset, onContinue }) => {
  const { renderAllThumbnails, error } = usePdfRenderer();
  const [previewsByFile, setPreviewsByFile] = useState<Record<string, PDFPagePreview[]>>({});
  const [progressByFile, setProgressByFile] = useState<
    Record<string, { current: number; total: number }>
  >({});
  const [errorsByFile, setErrorsByFile] = useState<Record<string, string>>({});
  const [settledIds, setSettledIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setPreviewsByFile({});
    setProgressByFile({});
    setErrorsByFile({});
    setSettledIds(new Set());

    (async () => {
      for (const file of files) {
        if (cancelled) return;
        try {
          const previews = await renderAllThumbnails(file.rawBuffer, (current, total) => {
            if (!cancelled) {
              setProgressByFile((prev) => ({ ...prev, [file.id]: { current, total } }));
            }
          });
          if (!cancelled) {
            setPreviewsByFile((prev) => ({
              ...prev,
              [file.id]: previews.slice(0, MAX_PREVIEW_PAGES),
            }));
          }
        } catch (err) {
          // Most commonly a password-protected file — no preview available,
          // but the file itself is still valid and can proceed to a tool
          // (e.g. Unlock) that can prompt for a password on its own.
          const msg = err instanceof Error ? err.message : 'Unable to render a preview for this file.';
          console.warn(`Failed to render preview for "${file.name}":`, err);
          if (!cancelled) setErrorsByFile((prev) => ({ ...prev, [file.id]: msg }));
        } finally {
          if (!cancelled) setSettledIds((prev) => new Set(prev).add(file.id));
        }
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const handleReset = () => {
    memoryManager.revokeAllUrls();
    onReset();
  };

  const allRendered = files.every((f) => settledIds.has(f.id));

  return (
    <div className="max-w-5xl mx-auto space-y-8">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <h3 className="text-lg font-bold text-slate-900 dark:text-white">
          Verify Your Documents ({files.length})
        </h3>
        <button
          type="button"
          onClick={handleReset}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-950/40 rounded-full active:scale-95 transition-all duration-150 self-start sm:self-auto"
        >
          <Trash2 className="w-4 h-4" />
          <span>Clear / Reset</span>
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2.5 p-3.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-xl text-xs text-rose-800 dark:text-rose-300">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
          <p>{error}</p>
        </div>
      )}

      {files.map((file) => {
        const previews = previewsByFile[file.id];
        const progress = progressByFile[file.id];
        const settled = settledIds.has(file.id);
        const fileError = errorsByFile[file.id];

        return (
          <div key={file.id} className="space-y-3">
            <div className="flex items-center gap-2 text-sm">
              <FileText className="w-4 h-4 text-rose-500 shrink-0" />
              <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                {file.name}
              </span>
              <span className="text-xs text-slate-400 shrink-0">
                {(file.size / 1024 / 1024).toFixed(2)} MB
                {previews
                  ? ` • ${previews.length}${previews.length >= MAX_PREVIEW_PAGES ? '+' : ''} page${
                      previews.length === 1 ? '' : 's'
                    }`
                  : ''}
              </span>
            </div>

            {fileError ? (
              <div className="flex items-start gap-2.5 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-xl text-xs text-amber-800 dark:text-amber-300">
                <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                <span>
                  No preview available (the file may be password-protected). You can still continue
                  to a tool — Unlock, for example, will prompt for the password there.
                </span>
              </div>
            ) : !settled ? (
              <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 p-4 bg-slate-50 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-800 rounded-xl">
                <Loader2 className="w-4 h-4 animate-spin text-rose-500" />
                <span>
                  Rendering thumbnails{progress ? ` (${progress.current}/${progress.total})` : '…'}
                </span>
              </div>
            ) : (
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3">
                {(previews ?? []).map((p) => (
                  <div
                    key={p.pageNumber}
                    className="relative rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-soft dark:shadow-soft-dark hover:-translate-y-0.5 transition-transform duration-200"
                  >
                    <img
                      src={p.dataUrl}
                      alt={`Page ${p.pageNumber} of ${file.name}`}
                      className="w-full h-auto block"
                    />
                    <div className="absolute bottom-0 inset-x-0 bg-black/60 text-white text-[10px] px-1.5 py-0.5 flex items-center justify-between">
                      <span>Pg {p.pageNumber}</span>
                      <span>{p.width > p.height ? 'Landscape' : 'Portrait'}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      <div className="flex justify-end pt-2">
        <button
          type="button"
          onClick={onContinue}
          disabled={!allRendered}
          className="inline-flex items-center gap-2 px-6 py-3 bg-gradient-to-r from-brand-600 to-brand-700 hover:from-brand-700 hover:to-brand-800 text-white font-bold text-sm rounded-2xl shadow-lg hover:shadow-xl hover:-translate-y-0.5 active:scale-[0.97] active:translate-y-0 transition-all duration-200 ease-out-expo disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:translate-y-0"
        >
          <span>Continue to Tool</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
