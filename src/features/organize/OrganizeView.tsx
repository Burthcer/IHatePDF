import React, { useState, useEffect, useRef } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PagePreviewModal } from '../../components/common/PagePreviewModal';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { LayoutGrid, Trash2, ArrowLeft, ArrowRight, RotateCcw, Copy, GripVertical, Maximize2 } from 'lucide-react';
import type { PDFFile, PDFPagePreview, ToolMetadata } from '../../types/pdf';
import type { OrganizePayload, ProcessedPdfResult } from '../../types/worker';

const ORGANIZE_TOOL_METADATA: ToolMetadata = {
  id: 'organize',
  title: 'Organize PDF',
  description: 'Sort, reorder, delete, or arrange pages of your PDF document.',
  icon: 'LayoutGrid',
  color: '#E53E3E',
  category: 'organize',
  acceptedFiles: 'single',
};

interface PageItem {
  key: string; // stable React/identity key; distinct even for duplicated pages
  originalIndex: number; // 0-based index into the source document
  preview?: PDFPagePreview;
}

let pageItemKeySeq = 0;
const nextPageItemKey = () => `page_${++pageItemKeySeq}`;

interface OrganizeViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const OrganizeView: React.FC<OrganizeViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [pages, setPages] = useState<PageItem[]>([]);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);

  const { renderThumbnails, isRendering } = usePdfRenderer();

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./organize.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length > 0) {
      renderThumbnails(files[0].rawBuffer, 40)
        .then(({ previews }) => {
          const pageItems = previews.map((p, idx) => ({
            key: nextPageItemKey(),
            originalIndex: idx,
            preview: p,
          }));
          setPages(pageItems);
        })
        .catch((err) => {
          console.warn('Error loading thumbnails for organize:', err);
        });
    }
  }, [files, renderThumbnails]);

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    setPages([]);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setPages([]);
    setResult(null);
    resetState();
  };

  const movePage = (currentIndex: number, direction: 'left' | 'right') => {
    const targetIndex = direction === 'left' ? currentIndex - 1 : currentIndex + 1;
    if (targetIndex < 0 || targetIndex >= pages.length) return;

    const newPages = [...pages];
    const [moved] = newPages.splice(currentIndex, 1);
    newPages.splice(targetIndex, 0, moved);
    setPages(newPages);
    setResult(null);
  };

  const handleDragStart = (index: number) => {
    dragIndexRef.current = index;
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDropReorder = (targetIndex: number) => {
    const sourceIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    if (sourceIndex === null || sourceIndex === targetIndex) return;

    setPages((prev) => {
      const reordered = [...prev];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      return reordered;
    });
    setResult(null);
  };

  const duplicatePage = (currentIndex: number) => {
    const source = pages[currentIndex];
    const duplicate: PageItem = { ...source, key: nextPageItemKey() };
    setPages((prev) => [
      ...prev.slice(0, currentIndex + 1),
      duplicate,
      ...prev.slice(currentIndex + 1),
    ]);
    setResult(null);
  };

  const deletePage = (currentIndex: number) => {
    setPages((prev) => prev.filter((_, idx) => idx !== currentIndex));
    setResult(null);
  };

  const resetPages = () => {
    if (files.length > 0) {
      renderThumbnails(files[0].rawBuffer, 40).then(({ previews }) => {
        setPages(
          previews.map((p, idx) => ({
            key: nextPageItemKey(),
            originalIndex: idx,
            preview: p,
          }))
        );
        setResult(null);
      });
    }
  };

  const executeOrganize = async () => {
    if (files.length === 0 || pages.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      // pageOrder may repeat an index when a page was duplicated; the worker's
      // copyPages call supports repeated source indices natively.
      const pageOrder = pages.map((p) => p.originalIndex);

      const payload: OrganizePayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        pageOrder,
      };

      const res = await runTask<OrganizePayload>('ORGANIZE_PAGES', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Organize error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  return (
    <ToolLayout
      tool={ORGANIZE_TOOL_METADATA}
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
      resultFileName={result?.fileName || 'organized_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Save New Order"
      onExecuteAction={executeOrganize}
      canExecute={files.length > 0 && pages.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Organize"
          subtitle="Reorder, remove, or rearrange pages in real-time"
        />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs">
            <div>
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">
                Page Sequence ({pages.length} remaining)
              </h3>
              <p className="text-xs text-slate-500">
                Use navigation arrows to reposition pages or the trash button to delete.
              </p>
            </div>

            <button
              type="button"
              onClick={resetPages}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 rounded-lg text-slate-700 dark:text-slate-200 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Reset Sequence</span>
            </button>
          </div>

          {isRendering ? (
            <div className="p-12 text-center text-slate-400">
              <LayoutGrid className="w-8 h-8 animate-spin mx-auto text-purple-600 mb-2" />
              <p className="text-sm font-medium">Extracting and ordering document pages...</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
              {pages.map((page, idx) => (
                <div
                  key={page.key}
                  draggable
                  onDragStart={() => handleDragStart(idx)}
                  onDragOver={handleDragOver}
                  onDrop={() => handleDropReorder(idx)}
                  className="group bg-slate-50 dark:bg-slate-900 p-3 rounded-xl border border-slate-200 dark:border-slate-800 flex flex-col items-center shadow-xs cursor-grab active:cursor-grabbing"
                >
                  <div className="w-full flex items-center justify-center text-slate-300 dark:text-slate-700 -mt-1 mb-1">
                    <GripVertical className="w-3.5 h-3.5" />
                  </div>
                  <div className="relative w-full aspect-[3/4] flex items-center justify-center overflow-hidden rounded bg-white dark:bg-slate-950 p-2 shadow-inner">
                    {page.preview ? (
                      <img
                        src={page.preview.dataUrl}
                        alt={`Page ${page.originalIndex + 1}`}
                        className="max-w-full max-h-full object-contain"
                      />
                    ) : (
                      <span className="text-xs text-slate-400">Page {page.originalIndex + 1}</span>
                    )}
                    {page.preview && (
                      <button
                        type="button"
                        draggable={false}
                        onClick={(e) => {
                          e.stopPropagation();
                          setPreviewIndex(idx);
                        }}
                        className="absolute bottom-1.5 right-1.5 p-1.5 rounded-lg bg-slate-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="View full quality"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>

                  <div className="w-full flex items-center justify-between mt-3 pt-2 border-t border-slate-200 dark:border-slate-800 text-xs">
                    <span className="font-bold text-slate-700 dark:text-slate-300">#{idx + 1}</span>

                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => movePage(idx, 'left')}
                        disabled={idx === 0}
                        aria-label="Move page left"
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-20"
                        title="Move Left"
                      >
                        <ArrowLeft className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => movePage(idx, 'right')}
                        disabled={idx === pages.length - 1}
                        aria-label="Move page right"
                        className="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 disabled:opacity-20"
                        title="Move Right"
                      >
                        <ArrowRight className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => duplicatePage(idx)}
                        aria-label="Duplicate page"
                        className="p-1 text-slate-400 hover:text-purple-600 ml-1 transition-colors"
                        title="Duplicate Page"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={() => deletePage(idx)}
                        disabled={pages.length === 1}
                        aria-label="Delete page"
                        className="p-1 text-slate-400 hover:text-rose-600 ml-1 transition-colors disabled:opacity-20"
                        title="Delete Page"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {previewIndex !== null && files.length > 0 && pages[previewIndex] && (
        <PagePreviewModal
          pdfBuffer={files[0].rawBuffer}
          pageNumber={previewIndex + 1}
          totalPages={pages.length}
          renderPageNumber={pages[previewIndex].originalIndex + 1}
          accentColor="#E53E3E"
          onClose={() => setPreviewIndex(null)}
          onNavigate={(n) => setPreviewIndex(n - 1)}
        />
      )}
    </ToolLayout>
  );
};
