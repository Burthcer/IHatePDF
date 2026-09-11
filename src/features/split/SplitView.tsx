import React, { useState, useEffect } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PagePreviewModal } from '../../components/common/PagePreviewModal';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Scissors, FileCheck, Layers, Maximize2, RefreshCw } from 'lucide-react';
import type { PDFFile, PDFPagePreview, ToolMetadata } from '../../types/pdf';
import type { SplitPayload, ProcessedPdfResult } from '../../types/worker';

const SPLIT_TOOL_METADATA: ToolMetadata = {
  id: 'split',
  title: 'Split PDF',
  description: 'Extract selected page ranges or split a PDF into smaller files.',
  icon: 'Scissors',
  color: '#E53E3E',
  category: 'organize',
  acceptedFiles: 'single',
};

interface SplitViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

/**
 * Parses a range string like "1-3, 5, 8-12" into validated {from, to} pairs,
 * clamped to [1, maxPage]. Throws with a user-facing message on bad input.
 */
function parseRangeString(input: string, maxPage: number): Array<{ from: number; to: number }> {
  const tokens = input
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Enter at least one page or range, e.g. "1-3, 5, 8-12".');
  }

  const ranges: Array<{ from: number; to: number }> = [];
  for (const token of tokens) {
    const match = token.match(/^(\d+)(?:-(\d+))?$/);
    if (!match) {
      throw new Error(`"${token}" is not a valid page or range.`);
    }
    const from = parseInt(match[1], 10);
    const to = match[2] ? parseInt(match[2], 10) : from;
    if (from < 1 || to < 1 || from > maxPage || to > maxPage || from > to) {
      throw new Error(`"${token}" is out of range for this ${maxPage}-page document.`);
    }
    ranges.push({ from, to });
  }
  return ranges;
}

export const SplitView: React.FC<SplitViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [splitMode, setSplitMode] = useState<'range' | 'all'>('range');
  const [rangeInput, setRangeInput] = useState<string>('1');
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [detectedPages, setDetectedPages] = useState<number>(1);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [pagePreviews, setPagePreviews] = useState<PDFPagePreview[]>([]);
  const [previewIndex, setPreviewIndex] = useState<number | null>(null);

  const { renderThumbnails, isRendering } = usePdfRenderer();

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length > 0) {
      renderThumbnails(files[0].rawBuffer, 60).then(({ previews, totalPages }) => {
        setDetectedPages(totalPages);
        setRangeInput(`1-${totalPages}`);
        setPagePreviews(previews);
      }).catch(() => {
        setDetectedPages(1);
        setRangeInput('1');
        setPagePreviews([]);
      });
    }
  }, [files, renderThumbnails]);

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    setPagePreviews([]);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    setPagePreviews([]);
    resetState();
  };

  const executeSplit = async () => {
    if (files.length === 0) return;
    const file = files[0];

    let ranges: SplitPayload['ranges'];
    if (splitMode === 'all') {
      ranges = 'all';
    } else {
      try {
        ranges = parseRangeString(rangeInput, detectedPages);
        setRangeError(null);
      } catch (err) {
        setRangeError(err instanceof Error ? err.message : 'Invalid page range.');
        return;
      }
    }

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: SplitPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        ranges,
      };

      const res = await runTask<SplitPayload>('SPLIT_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Split error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      const mimeType = result.fileName.endsWith('.zip') ? 'application/zip' : 'application/pdf';
      memoryManager.downloadBuffer(result.buffer, result.fileName, mimeType);
    }
  };

  return (
    <ToolLayout
      tool={SPLIT_TOOL_METADATA}
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
      resultFileName={result?.fileName || 'split_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Split PDF"
      onExecuteAction={executeSplit}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Split"
          subtitle="Extract single pages or ranges locally"
        />
      ) : (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-6">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Scissors className="w-5 h-5 text-amber-500" />
              <span>Split Configuration</span>
            </h3>

            {/* Mode selection */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <button
                type="button"
                onClick={() => setSplitMode('range')}
                className={`p-4 rounded-xl border text-left flex items-start gap-3 transition-all ${
                  splitMode === 'range'
                    ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20 text-amber-950 dark:text-amber-100 ring-2 ring-amber-500/20'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <Layers className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Extract Range</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Extract a specific continuous range of pages into a single PDF.
                  </p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => setSplitMode('all')}
                className={`p-4 rounded-xl border text-left flex items-start gap-3 transition-all ${
                  splitMode === 'all'
                    ? 'border-amber-500 bg-amber-50/50 dark:bg-amber-950/20 text-amber-950 dark:text-amber-100 ring-2 ring-amber-500/20'
                    : 'border-slate-200 dark:border-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <FileCheck className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold text-sm">Extract All Pages</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                    Burst all {detectedPages} pages into individual PDFs, packaged as one ZIP.
                  </p>
                </div>
              </button>
            </div>

            {/* Range Input */}
            {splitMode === 'range' && (
              <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-xl border border-slate-200 dark:border-slate-700 space-y-2">
                <label htmlFor="split-range-input" className="text-sm font-medium text-slate-700 dark:text-slate-300">
                  Pages to extract
                </label>
                <input
                  id="split-range-input"
                  type="text"
                  value={rangeInput}
                  onChange={(e) => {
                    setRangeInput(e.target.value);
                    setRangeError(null);
                  }}
                  placeholder="e.g. 1-3, 5, 8-12"
                  className="w-full px-3 py-1.5 bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 rounded-lg text-sm font-semibold text-slate-800 dark:text-slate-100 focus:ring-2 focus:ring-amber-500"
                />
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Comma-separated pages or ranges. Document contains {detectedPages} total pages.
                </p>
                {rangeError && (
                  <p className="text-xs font-semibold text-rose-600 dark:text-rose-400">{rangeError}</p>
                )}
              </div>
            )}
          </div>

          {/* Page Preview Grid — verify exactly what you're extracting, in full quality */}
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-4">
            <h3 className="font-bold text-sm text-slate-800 dark:text-slate-200">Document Pages</h3>
            {isRendering ? (
              <div className="p-12 text-center text-slate-400">
                <RefreshCw className="w-8 h-8 animate-spin mx-auto text-amber-500 mb-2" />
                <p className="text-sm font-medium">Rendering page previews...</p>
              </div>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                {pagePreviews.map((preview, idx) => (
                  <div
                    key={preview.pageNumber}
                    className="group bg-slate-50 dark:bg-slate-950 p-2 rounded-xl border border-slate-200 dark:border-slate-800"
                  >
                    <div className="relative w-full aspect-[3/4] flex items-center justify-center overflow-hidden rounded bg-white dark:bg-slate-900">
                      <img
                        src={preview.dataUrl}
                        alt={`Page ${preview.pageNumber}`}
                        className="max-w-full max-h-full object-contain"
                      />
                      <button
                        type="button"
                        onClick={() => setPreviewIndex(idx)}
                        className="absolute bottom-1 right-1 p-1.5 rounded-lg bg-slate-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                        title="View full quality"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-center text-xs font-semibold text-slate-500 mt-1.5">
                      Page {preview.pageNumber}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {previewIndex !== null && files.length > 0 && pagePreviews[previewIndex] && (
        <PagePreviewModal
          pdfBuffer={files[0].rawBuffer}
          pageNumber={pagePreviews[previewIndex].pageNumber}
          totalPages={detectedPages}
          accentColor="#E53E3E"
          onClose={() => setPreviewIndex(null)}
          onNavigate={(n) => {
            const targetIdx = pagePreviews.findIndex((p) => p.pageNumber === n);
            setPreviewIndex(targetIdx !== -1 ? targetIdx : null);
          }}
        />
      )}
    </ToolLayout>
  );
};
