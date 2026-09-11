import React, { useEffect, useRef, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { EyeOff, Trash2 } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { RedactionBox, RedactPdfPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'redact',
  title: 'Redact PDF',
  description: 'Permanently black out sensitive text or images — irrecoverably.',
  icon: 'EyeOff',
  color: '#6366F1',
  category: 'edit',
  acceptedFiles: 'single',
};

interface RedactViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

const DISPLAY_WIDTH = 700;
const EXPORT_WIDTH = 1600; // full-resolution rasterization used for the final, irrecoverable output

export const RedactView: React.FC<RedactViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [totalPages, setTotalPages] = useState(1);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSizePt, setPageSizePt] = useState({ width: 595.28, height: 841.89 });
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [boxes, setBoxes] = useState<RedactionBox[]>([]);
  const [draftBox, setDraftBox] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [rasterProgress, setRasterProgress] = useState<{ current: number; total: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const drawStartRef = useRef<{ px: number; py: number } | null>(null);

  const { getPageCount, loadDocument, renderPage, renderAllPageImages } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./redact.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length === 0) return;
    getPageCount(files[0].rawBuffer)
      .then((count) => setTotalPages(count))
      .catch(() => setTotalPages(1));
  }, [files, getPageCount]);

  useEffect(() => {
    if (files.length === 0) return;
    let cancelled = false;
    loadDocument(files[0].rawBuffer)
      .then(async (doc) => {
        try {
          const page = await doc.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          if (cancelled) return;
          setPageSizePt({ width: viewport.width, height: viewport.height });
          const preview = await renderPage(doc, pageIndex + 1, DISPLAY_WIDTH / viewport.width);
          if (!cancelled) setPageImage(preview.dataUrl);
        } finally {
          await memoryManager.destroyPdfDocument(doc);
        }
      })
      .catch(() => {
        if (!cancelled) setPageSizePt({ width: 595.28, height: 841.89 });
      });
    return () => {
      cancelled = true;
    };
  }, [files, pageIndex, loadDocument, renderPage]);

  const scalePxToPt = pageSizePt.width / DISPLAY_WIDTH;
  const displayHeight = DISPLAY_WIDTH * (pageSizePt.height / pageSizePt.width);

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
    setBoxes([]);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setBoxes([]);
    setResult(null);
    resetState();
  };

  const getRelativePoint = (clientX: number, clientY: number) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { px: clientX - rect.left, py: clientY - rect.top };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const { px, py } = getRelativePoint(e.clientX, e.clientY);
    drawStartRef.current = { px, py };
    setDraftBox({ x0: px, y0: py, x1: px, y1: py });
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!drawStartRef.current) return;
    const { px, py } = getRelativePoint(e.clientX, e.clientY);
    setDraftBox({ x0: drawStartRef.current.px, y0: drawStartRef.current.py, x1: px, y1: py });
  };

  const handlePointerUp = () => {
    if (!drawStartRef.current || !draftBox) {
      drawStartRef.current = null;
      return;
    }
    const left = Math.min(draftBox.x0, draftBox.x1);
    const top = Math.min(draftBox.y0, draftBox.y1);
    const w = Math.abs(draftBox.x1 - draftBox.x0);
    const h = Math.abs(draftBox.y1 - draftBox.y0);

    if (w > 4 && h > 4) {
      const box: RedactionBox = {
        pageIndex,
        xPt: left * scalePxToPt,
        yPt: pageSizePt.height - (top + h) * scalePxToPt,
        widthPt: w * scalePxToPt,
        heightPt: h * scalePxToPt,
      };
      setBoxes((prev) => [...prev, box]);
      setResult(null);
    }
    drawStartRef.current = null;
    setDraftBox(null);
  };

  const removeBox = (index: number) => {
    setBoxes((prev) => prev.filter((_, i) => i !== index));
    setResult(null);
  };

  const executeRedact = async () => {
    if (files.length === 0 || boxes.length === 0) return;
    const file = files[0];
    try {
      const pages = await renderAllPageImages(file.rawBuffer.slice(0), EXPORT_WIDTH, (current, total) =>
        setRasterProgress({ current, total })
      );
      setRasterProgress(null);

      const payload: RedactPdfPayload = {
        pageImages: pages.map((p, i) => ({ pageNumber: i + 1, dataUrl: p.dataUrl })),
        pageSizesPt: pages.map((p) => ({ width: p.widthPt, height: p.heightPt })),
        boxes,
        fileName: file.name,
      };
      const res = await runTask<RedactPdfPayload>('REDACT_PDF', payload);
      setResult(res);
    } catch (err) {
      setRasterProgress(null);
      console.error('Redact error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  const pageBoxIndices = boxes
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => b.pageIndex === pageIndex);

  const busy = isProcessing || rasterProgress !== null;
  const stageLabel = rasterProgress ? `Rasterizing page ${rasterProgress.current}/${rasterProgress.total} at full resolution...` : stage;
  const progressValue = rasterProgress ? Math.round((rasterProgress.current / rasterProgress.total) * 60) : 60 + progress * 0.4;

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#6366F1"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={busy}
      progress={progressValue}
      stage={stageLabel}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'redacted_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Redact & Save"
      onExecuteAction={executeRedact}
      canExecute={files.length > 0 && boxes.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF to redact" subtitle="Draw boxes over content to permanently remove it" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <EyeOff className="w-5 h-5 text-[#6366F1]" />
              <span>Drag to draw redaction boxes</span>
            </h3>
            <select
              value={pageIndex}
              onChange={(e) => setPageIndex(parseInt(e.target.value, 10))}
              className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-900 dark:text-white"
            >
              {Array.from({ length: totalPages }, (_, i) => (
                <option key={i} value={i}>
                  Page {i + 1}
                  {boxes.some((b) => b.pageIndex === i) ? ` (${boxes.filter((b) => b.pageIndex === i).length})` : ''}
                </option>
              ))}
            </select>
          </div>

          <p className="text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg px-3 py-2">
            Every page is rasterized to a flat image and rebuilt as a new PDF — the text and objects
            underneath a black box are gone, not just covered.
          </p>

          <div
            ref={containerRef}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            className="relative bg-slate-100 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden cursor-crosshair touch-none"
            style={{ width: DISPLAY_WIDTH, height: displayHeight, backgroundImage: pageImage ? `url(${pageImage})` : undefined, backgroundSize: '100% 100%' }}
          >
            {pageBoxIndices.map(({ b, i }) => {
              const leftPx = b.xPt / scalePxToPt;
              const topPx = (pageSizePt.height - b.yPt - b.heightPt) / scalePxToPt;
              return (
                <div
                  key={i}
                  className="absolute bg-black group flex items-center justify-center"
                  style={{ left: leftPx, top: topPx, width: b.widthPt / scalePxToPt, height: b.heightPt / scalePxToPt }}
                >
                  <button
                    onClick={(ev) => {
                      ev.stopPropagation();
                      removeBox(i);
                    }}
                    className="opacity-0 group-hover:opacity-100 p-1 bg-white/90 rounded text-rose-600 transition-opacity"
                    title="Remove box"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              );
            })}

            {draftBox && (
              <div
                className="absolute bg-black/60 border-2 border-indigo-500"
                style={{
                  left: Math.min(draftBox.x0, draftBox.x1),
                  top: Math.min(draftBox.y0, draftBox.y1),
                  width: Math.abs(draftBox.x1 - draftBox.x0),
                  height: Math.abs(draftBox.y1 - draftBox.y0),
                }}
              />
            )}
          </div>

          {boxes.length > 0 && (
            <p className="text-xs font-semibold text-slate-500">
              {boxes.length} redaction box{boxes.length === 1 ? '' : 'es'} across all pages
            </p>
          )}
        </div>
      )}
    </ToolLayout>
  );
};
