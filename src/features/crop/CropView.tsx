import React, { useEffect, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PagePreviewModal } from '../../components/common/PagePreviewModal';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Crop, Maximize2 } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { CropPayload, ProcessedPdfResult } from '../../types/worker';

const CROP_TOOL_METADATA: ToolMetadata = {
  id: 'crop',
  title: 'Crop PDF',
  description: 'Trim page margins on every side of your document.',
  icon: 'Crop',
  color: '#E53E3E',
  category: 'organize',
  acceptedFiles: 'single',
};

interface CropViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const CropView: React.FC<CropViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [margins, setMargins] = useState({ top: 10, bottom: 10, left: 10, right: 10 });
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [pageThumbnail, setPageThumbnail] = useState<string | null>(null);
  const [totalPages, setTotalPages] = useState(1);
  const [showPreview, setShowPreview] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);

  const { renderThumbnail, getPageCount } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./crop.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length === 0) {
      setPageThumbnail(null);
      return;
    }
    renderThumbnail(files[0].rawBuffer, 1, 400).then(setPageThumbnail).catch(() => setPageThumbnail(null));
    getPageCount(files[0].rawBuffer).then(setTotalPages).catch(() => setTotalPages(1));
  }, [files, renderThumbnail, getPageCount]);

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

  const setMargin = (key: keyof typeof margins, value: number) => {
    setMargins((prev) => ({ ...prev, [key]: Math.max(0, value) }));
  };

  const executeCrop = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: CropPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        margins,
      };

      const res = await runTask<CropPayload>('CROP_PAGES', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Crop error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  const marginFields: Array<{ key: keyof typeof margins; label: string }> = [
    { key: 'top', label: 'Top' },
    { key: 'bottom', label: 'Bottom' },
    { key: 'left', label: 'Left' },
    { key: 'right', label: 'Right' },
  ];

  return (
    <ToolLayout
      tool={CROP_TOOL_METADATA}
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
      resultFileName={result?.fileName || 'cropped_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Crop PDF"
      onExecuteAction={executeCrop}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Crop"
          subtitle="Trim margins on every page"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-6">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Crop className="w-5 h-5 text-[#E53E3E]" />
            <span>Margins (millimeters)</span>
          </h3>

          {/* Visual crop-margin preview, drawn over the actual first page */}
          <div className="relative mx-auto w-48 aspect-[3/4] bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600 rounded overflow-hidden group">
            {pageThumbnail && (
              <img src={pageThumbnail} alt="First page" className="absolute inset-0 w-full h-full object-contain" />
            )}
            <div
              className="absolute border-2 border-dashed border-[#E53E3E] bg-white/40 dark:bg-slate-950/40"
              style={{
                top: `${Math.min(45, margins.top)}%`,
                bottom: `${Math.min(45, margins.bottom)}%`,
                left: `${Math.min(45, margins.left)}%`,
                right: `${Math.min(45, margins.right)}%`,
              }}
            />
            {pageThumbnail && (
              <button
                type="button"
                onClick={() => {
                  setPreviewPage(1);
                  setShowPreview(true);
                }}
                className="absolute bottom-1.5 right-1.5 p-1.5 rounded-lg bg-slate-900/70 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                title="View full quality"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
          <p className="text-[11px] text-slate-400 text-center -mt-3">
            Dashed line shows what will be trimmed, over your document's actual first page.
          </p>

          <div className="grid grid-cols-2 gap-4 max-w-sm mx-auto">
            {marginFields.map(({ key, label }) => (
              <div key={key}>
                <label htmlFor={`crop-${key}`} className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  {label}
                </label>
                <div className="relative">
                  <input
                    id={`crop-${key}`}
                    type="number"
                    min={0}
                    value={margins[key]}
                    onChange={(e) => setMargin(key, parseFloat(e.target.value) || 0)}
                    className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-[#E53E3E]"
                  />
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400">mm</span>
                </div>
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-500 dark:text-slate-400 text-center">
            Applied to every page. 1 inch ≈ 25.4mm.
          </p>
        </div>
      )}

      {showPreview && files.length > 0 && (
        <PagePreviewModal
          pdfBuffer={files[0].rawBuffer}
          pageNumber={previewPage}
          totalPages={totalPages}
          accentColor="#E53E3E"
          onClose={() => setShowPreview(false)}
          onNavigate={setPreviewPage}
        />
      )}
    </ToolLayout>
  );
};
