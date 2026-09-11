import React, { useState, useEffect, useRef } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PagePreviewModal } from '../../components/common/PagePreviewModal';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { ArrowUp, ArrowDown, Plus, FileText, GripVertical, Maximize2 } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { MergePayload, ProcessedPdfResult } from '../../types/worker';

const MERGE_TOOL_METADATA: ToolMetadata = {
  id: 'merge',
  title: 'Merge PDF Documents',
  description: 'Combine multiple PDF files into one unified document in your preferred order.',
  icon: 'Combine',
  color: '#E53E3E',
  category: 'organize',
  acceptedFiles: 'multiple',
};

interface MergeViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const MergeView: React.FC<MergeViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [coverThumbnails, setCoverThumbnails] = useState<Record<string, string>>({});
  const [pageCounts, setPageCounts] = useState<Record<string, number>>({});
  const [previewFileId, setPreviewFileId] = useState<string | null>(null);
  const [previewPageNumber, setPreviewPageNumber] = useState(1);
  const dragIndexRef = useRef<number | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' })
    );

  const { renderThumbnail, getPageCount } = usePdfRenderer();

  // Generate a cover thumbnail + page count for any file that doesn't have one yet.
  useEffect(() => {
    let cancelled = false;
    for (const file of files) {
      if (coverThumbnails[file.id] === undefined) {
        renderThumbnail(file.rawBuffer, 1, 80)
          .then((dataUrl) => {
            if (!cancelled) setCoverThumbnails((prev) => ({ ...prev, [file.id]: dataUrl }));
          })
          .catch(() => {
            if (!cancelled) setCoverThumbnails((prev) => ({ ...prev, [file.id]: '' }));
          });
      }
      if (pageCounts[file.id] === undefined) {
        getPageCount(file.rawBuffer)
          .then((count) => {
            if (!cancelled) setPageCounts((prev) => ({ ...prev, [file.id]: count }));
          })
          .catch(() => {
            if (!cancelled) setPageCounts((prev) => ({ ...prev, [file.id]: 0 }));
          });
      }
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [files]);

  const totalPages = files.reduce((sum, f) => sum + (pageCounts[f.id] || 0), 0);

  const handleFilesAccepted = (newFiles: PDFFile[]) => {
    setFiles((prev) => [...prev, ...newFiles]);
    setResult(null);
    resetState();
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

    setFiles((prev) => {
      const reordered = [...prev];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      return reordered;
    });
    setResult(null);
  };

  const handleRemoveFile = (id: string) => {
    setFiles((prev) => prev.filter((f) => f.id !== id));
    setResult(null);
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const moveFile = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= files.length) return;

    const reordered = [...files];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(targetIndex, 0, moved);
    setFiles(reordered);
    setResult(null);
  };

  const executeMerge = async () => {
    if (files.length < 2) return;

    try {
      // Prepare buffers for transfer (clone buffers so state can retain files if needed)
      const payloadFiles = files.map((f) => ({
        name: f.name,
        buffer: f.rawBuffer.slice(0),
      }));

      const transferables = payloadFiles.map((f) => f.buffer);

      const payload: MergePayload = {
        files: payloadFiles,
      };

      const res = await runTask<MergePayload>('MERGE_PDFS', payload, transferables);
      setResult(res);
    } catch (err) {
      console.error('Merge error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  return (
    <ToolLayout
      tool={MERGE_TOOL_METADATA}
      accentColor="#E53E3E"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleRemoveFile}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'merged_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Merge Files"
      onExecuteAction={executeMerge}
      canExecute={files.length >= 2}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={true}
          onFilesAccepted={handleFilesAccepted}
          title="Select PDF files to Merge"
          subtitle="Select 2 or more files to combine into a single PDF"
        />
      ) : (
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-base font-bold text-slate-800 dark:text-slate-200">
                Merge Sequence (Drag or use arrows to arrange order)
              </h3>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                {files.length} file{files.length === 1 ? '' : 's'} • {totalPages} total page
                {totalPages === 1 ? '' : 's'}
              </p>
            </div>
            <div className="relative">
              <label
                htmlFor="add-more-merge-input"
                className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-semibold rounded-lg cursor-pointer text-slate-700 dark:text-slate-200 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add More Files</span>
              </label>
              <input
                id="add-more-merge-input"
                type="file"
                multiple
                accept=".pdf"
                className="hidden"
                onChange={async (e) => {
                  if (e.target.files) {
                    const newFiles: PDFFile[] = [];
                    for (const file of Array.from(e.target.files)) {
                      const buf = await file.arrayBuffer();
                      newFiles.push({
                        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
                        name: file.name,
                        size: file.size,
                        pageCount: 0,
                        rawBuffer: buf,
                        previewUrls: [],
                      });
                    }
                    handleFilesAccepted(newFiles);
                    e.target.value = '';
                  }
                }}
              />
            </div>
          </div>

          <div className="space-y-2">
            {files.map((file, index) => (
              <div
                key={file.id}
                draggable
                onDragStart={() => handleDragStart(index)}
                onDragOver={handleDragOver}
                onDrop={() => handleDropReorder(index)}
                className="flex items-center justify-between p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl shadow-xs hover:border-slate-300 transition-all cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <GripVertical className="w-4 h-4 text-slate-300 dark:text-slate-600 shrink-0" />
                  <span className="w-6 h-6 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-600 dark:text-rose-400 font-bold text-xs flex items-center justify-center shrink-0">
                    {index + 1}
                  </span>
                  {coverThumbnails[file.id] ? (
                    <button
                      type="button"
                      draggable={false}
                      onClick={(e) => {
                        e.stopPropagation();
                        setPreviewFileId(file.id);
                        setPreviewPageNumber(1);
                      }}
                      className="relative group/cover shrink-0"
                      title="View full quality"
                    >
                      <img
                        src={coverThumbnails[file.id]}
                        alt={`Cover of ${file.name}`}
                        className="w-8 h-10 object-cover rounded border border-slate-200 dark:border-slate-700"
                      />
                      <span className="absolute inset-0 flex items-center justify-center rounded bg-black/0 group-hover/cover:bg-black/40 transition-colors">
                        <Maximize2 className="w-3 h-3 text-white opacity-0 group-hover/cover:opacity-100 transition-opacity" />
                      </span>
                    </button>
                  ) : (
                    <FileText className="w-5 h-5 text-rose-500 shrink-0" />
                  )}
                  <div className="min-w-0">
                    <p className="font-semibold text-sm text-slate-800 dark:text-slate-200 truncate">
                      {file.name}
                    </p>
                    <p className="text-xs text-slate-400">
                      {(file.size / 1024 / 1024).toFixed(2)} MB
                      {pageCounts[file.id] ? ` • ${pageCounts[file.id]} pages` : ''}
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => moveFile(index, 'up')}
                    disabled={index === 0 || isProcessing}
                    aria-label="Move file up in merge order"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                  >
                    <ArrowUp className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => moveFile(index, 'down')}
                    disabled={index === files.length - 1 || isProcessing}
                    aria-label="Move file down in merge order"
                    className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30"
                  >
                    <ArrowDown className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {files.length < 2 && (
            <p className="text-xs text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/40 p-3 rounded-lg border border-amber-200 dark:border-amber-900">
              Please add at least 2 PDF files to enable merging.
            </p>
          )}
        </div>
      )}

      {previewFileId && (() => {
        const previewFile = files.find((f) => f.id === previewFileId);
        if (!previewFile) return null;
        return (
          <PagePreviewModal
            pdfBuffer={previewFile.rawBuffer}
            pageNumber={previewPageNumber}
            totalPages={pageCounts[previewFileId] || 1}
            accentColor="#E53E3E"
            onClose={() => setPreviewFileId(null)}
            onNavigate={setPreviewPageNumber}
          />
        );
      })()}
    </ToolLayout>
  );
};
