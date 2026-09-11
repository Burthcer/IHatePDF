import React, { useEffect, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Hash } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type {
  PageNumbersPayload,
  PageNumberFormat,
  WatermarkPosition,
  ProcessedPdfResult,
} from '../../types/worker';
import { PositionGrid } from '../../components/common/PositionGrid';

const PAGE_NUMBERS_TOOL_METADATA: ToolMetadata = {
  id: 'pageNumbers',
  title: 'Page Numbers',
  description: 'Add page numbers with custom position, format, and range.',
  icon: 'Hash',
  color: '#F59E0B',
  category: 'edit',
  acceptedFiles: 'single',
};

const FORMAT_OPTIONS: Array<{ value: PageNumberFormat; label: string; example: string }> = [
  { value: 'n', label: 'Number only', example: '1' },
  { value: 'n_of_total', label: 'Page N of Total', example: 'Page 1 of 12' },
  { value: 'roman', label: 'Roman numerals', example: 'i' },
];

interface PageNumbersViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PageNumbersView: React.FC<PageNumbersViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [totalPages, setTotalPages] = useState(1);
  const [format, setFormat] = useState<PageNumberFormat>('n_of_total');
  const [position, setPosition] = useState<WatermarkPosition>('bottom-center');
  const [fontSize, setFontSize] = useState(12);
  const [color, setColor] = useState('#475569');
  const [marginMm, setMarginMm] = useState(10);
  const [startPage, setStartPage] = useState(1);
  const [endPage, setEndPage] = useState(1);
  const [startingNumber, setStartingNumber] = useState(1);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { getPageCount } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./pageNumbers.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length > 0) {
      getPageCount(files[0].rawBuffer)
        .then((count) => {
          setTotalPages(count);
          setEndPage(count);
        })
        .catch(() => {
          setTotalPages(1);
          setEndPage(1);
        });
    }
  }, [files, getPageCount]);

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const executeAddNumbers = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: PageNumbersPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        format,
        position,
        fontSize,
        color,
        marginMm,
        startPage,
        endPage,
        startingNumber,
      };

      const res = await runTask<PageNumbersPayload>('ADD_PAGE_NUMBERS', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Page numbers error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  return (
    <ToolLayout
      tool={PAGE_NUMBERS_TOOL_METADATA}
      accentColor="#F59E0B"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'numbered_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Add Page Numbers"
      onExecuteAction={executeAddNumbers}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file"
          subtitle="Add page numbers to your document"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-6">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Hash className="w-5 h-5 text-[#F59E0B]" />
            <span>Page Number Settings</span>
          </h3>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Format</label>
                <div className="space-y-1.5">
                  {FORMAT_OPTIONS.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setFormat(opt.value)}
                      className={`w-full flex items-center justify-between px-3 py-2 rounded-lg border text-left text-sm transition-colors ${
                        format === opt.value
                          ? 'border-[#F59E0B] bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      <span className="font-medium">{opt.label}</span>
                      <span className="text-xs text-slate-400">{opt.example}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="pn-fontsize" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Font Size
                  </label>
                  <input
                    id="pn-fontsize"
                    type="number"
                    min={6}
                    max={48}
                    value={fontSize}
                    onChange={(e) => setFontSize(parseInt(e.target.value, 10) || 12)}
                    className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div>
                  <label htmlFor="pn-color" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Color
                  </label>
                  <input
                    id="pn-color"
                    type="color"
                    value={color}
                    onChange={(e) => setColor(e.target.value)}
                    className="w-full h-[34px] bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                  />
                </div>
              </div>

              <div>
                <label htmlFor="pn-margin" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Margin from edge (mm)
                </label>
                <input
                  id="pn-margin"
                  type="number"
                  min={0}
                  value={marginMm}
                  onChange={(e) => setMarginMm(parseFloat(e.target.value) || 0)}
                  className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label htmlFor="pn-start" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    From page
                  </label>
                  <input
                    id="pn-start"
                    type="number"
                    min={1}
                    max={totalPages}
                    value={startPage}
                    onChange={(e) => setStartPage(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-center text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div>
                  <label htmlFor="pn-end" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    To page
                  </label>
                  <input
                    id="pn-end"
                    type="number"
                    min={startPage}
                    max={totalPages}
                    value={endPage}
                    onChange={(e) => setEndPage(Math.min(totalPages, parseInt(e.target.value, 10) || totalPages))}
                    className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-center text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
                <div>
                  <label htmlFor="pn-startnum" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Start at #
                  </label>
                  <input
                    id="pn-startnum"
                    type="number"
                    min={1}
                    value={startingNumber}
                    onChange={(e) => setStartingNumber(Math.max(1, parseInt(e.target.value, 10) || 1))}
                    className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-center text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                  />
                </div>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">
                Document has {totalPages} page{totalPages === 1 ? '' : 's'}.
              </p>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Position</label>
              <PositionGrid value={position} onChange={setPosition} accentColor="#F59E0B" />
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
