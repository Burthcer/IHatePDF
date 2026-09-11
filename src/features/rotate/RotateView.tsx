import React, { useState, useEffect } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PagePreviewModal } from '../../components/common/PagePreviewModal';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { RotateCw, RotateCcw, RefreshCw, Maximize2 } from 'lucide-react';
import type { PDFFile, PDFPagePreview, ToolMetadata } from '../../types/pdf';
import type { RotatePayload, ProcessedPdfResult } from '../../types/worker';

const ROTATE_TOOL_METADATA: ToolMetadata = {
  id: 'rotate',
  title: 'Rotate PDF',
  description: 'Rotate your PDF pages individual or globally (90°, 180°, 270°).',
  icon: 'RotateCw',
  color: '#E53E3E',
  category: 'organize',
  acceptedFiles: 'single',
};

interface RotateViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const RotateView: React.FC<RotateViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [pagePreviews, setPagePreviews] = useState<PDFPagePreview[]>([]);
  const [pageRotations, setPageRotations] = useState<Record<number, number>>({});
  const [globalRotation, setGlobalRotation] = useState<number>(0);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const { renderThumbnails, isRendering } = usePdfRenderer();

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./rotate.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length > 0) {
      renderThumbnails(files[0].rawBuffer, 30)
        .then(({ previews }) => {
          setPagePreviews(previews);
          const initialMap: Record<number, number> = {};
          previews.forEach((p, idx) => {
            initialMap[idx] = 0;
          });
          setPageRotations(initialMap);
        })
        .catch((err) => {
          console.warn('Error generating thumbnails:', err);
        });
    }
  }, [files, renderThumbnails]);

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    setPagePreviews([]);
    setGlobalRotation(0);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setPagePreviews([]);
    setResult(null);
    setGlobalRotation(0);
    resetState();
  };

  const rotateSinglePage = (pageIndex: number, deltaDegrees: number) => {
    setPageRotations((prev) => ({
      ...prev,
      [pageIndex]: ((prev[pageIndex] || 0) + deltaDegrees + 360) % 360,
    }));
    setResult(null);
  };

  const rotateAllPages = (deltaDegrees: number) => {
    setGlobalRotation((prev) => (prev + deltaDegrees + 360) % 360);
    setResult(null);
  };

  const executeRotate = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);

      const rotationsList = Object.entries(pageRotations).map(([idxStr, deg]) => ({
        pageIndex: parseInt(idxStr, 10),
        degrees: deg,
      }));

      const payload: RotatePayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        rotations: rotationsList,
        globalDegrees: globalRotation,
      };

      const res = await runTask<RotatePayload>('ROTATE_PAGES', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Rotate error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  return (
    <ToolLayout
      tool={ROTATE_TOOL_METADATA}
      accentColor="#E53E3E"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'rotated_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Apply Rotation"
      onExecuteAction={executeRotate}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Rotate"
          subtitle="Rotate pages clockwise or counter-clockwise"
        />
      ) : (
        <div className="space-y-6">
          {/* Global Controls */}
          <div className="flex flex-wrap items-center justify-between gap-4 p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
            <span className="text-sm font-bold text-slate-800 dark:text-slate-200">
              Bulk Orientation:
            </span>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => rotateAllPages(270)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold rounded-lg transition-colors text-slate-700 dark:text-slate-200"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Rotate All Left 90°</span>
              </button>

              <button
                type="button"
                onClick={() => rotateAllPages(90)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-xs font-semibold rounded-lg transition-colors text-white"
              >
                <RotateCw className="w-3.5 h-3.5" />
                <span>Rotate All Right 90°</span>
              </button>

              <button
                type="button"
                onClick={() => rotateAllPages(180)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-semibold rounded-lg transition-colors text-slate-700 dark:text-slate-200"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Flip All 180°</span>
              </button>
            </div>
          </div>

          {/* Page Preview Grid */}
          {isRendering ? (
            <div className="p-12 text-center text-slate-400 space-y-2">
              <RefreshCw className="w-8 h-8 animate-spin mx-auto text-emerald-500" />
              <p className="text-sm font-medium">Generating visual page thumbnails...</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {pagePreviews.map((preview, idx) => {
                const totalAngle = ((pageRotations[idx] || 0) + globalRotation) % 360;
                return (
                  <div
                    key={preview.pageNumber}
                    className="relative group bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col items-center shadow-xs"
                  >
                    <div className="relative w-full aspect-[3/4] flex items-center justify-center overflow-hidden rounded bg-white dark:bg-slate-950 p-2 shadow-inner">
                      <img
                        src={preview.dataUrl}
                        alt={`Page ${preview.pageNumber}`}
                        className="max-w-full max-h-full object-contain transition-transform duration-300"
                        style={{ transform: `rotate(${totalAngle}deg)` }}
                      />
                      <button
                        type="button"
                        onClick={() => setPreviewIndex(idx)}
                        className="absolute bottom-1.5 right-1.5 p-1.5 rounded-lg bg-slate-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="View full quality"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <div className="w-full flex items-center justify-between mt-3 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
                      <span className="font-semibold text-slate-600 dark:text-slate-400">
                        Page {preview.pageNumber}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() => rotateSinglePage(idx, 90)}
                          aria-label={`Rotate Page ${preview.pageNumber} 90 degrees`}
                          className="p-1 text-slate-500 hover:text-emerald-600 hover:bg-slate-200 dark:hover:bg-slate-800 rounded transition-colors"
                          title="Rotate +90°"
                        >
                          <RotateCw className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {previewIndex !== null && files.length > 0 && pagePreviews[previewIndex] && (
        <PagePreviewModal
          pdfBuffer={files[0].rawBuffer}
          pageNumber={previewIndex + 1}
          totalPages={pagePreviews.length}
          rotationDegrees={((pageRotations[previewIndex] || 0) + globalRotation) % 360}
          accentColor="#E53E3E"
          onClose={() => setPreviewIndex(null)}
          onNavigate={(n) => setPreviewIndex(n - 1)}
        />
      )}
    </ToolLayout>
  );
};
