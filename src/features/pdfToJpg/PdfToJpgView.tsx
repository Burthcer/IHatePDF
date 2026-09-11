import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Image as ImageIcon } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { BuildJpgZipPayload, ProcessedPdfResult, RenderedPageImage } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToJpg',
  title: 'PDF to JPG',
  description: 'Convert each PDF page into a JPG image.',
  icon: 'ImageIcon',
  color: '#0284C7',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PdfToJpgViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToJpgView: React.FC<PdfToJpgViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);

  const { renderAllPageImages } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./pdfToJpg.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    setRenderProgress(null);
    resetState();
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const rendered = await renderAllPageImages(file.rawBuffer, 1600, (current, total) =>
        setRenderProgress({ current, total })
      );
      setRenderProgress(null);

      const images: RenderedPageImage[] = rendered.map((r, idx) => ({ pageNumber: idx + 1, dataUrl: r.dataUrl }));
      const payload: BuildJpgZipPayload = { images, fileName: file.name };
      const res = await runTask<BuildJpgZipPayload>('BUILD_JPG_ZIP', payload);
      setResult(res);
    } catch (err) {
      setRenderProgress(null);
      console.error('PDF to JPG error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      const mime = result.fileName.endsWith('.zip') ? 'application/zip' : 'image/jpeg';
      memoryManager.downloadBuffer(result.buffer, result.fileName, mime);
    }
  };

  const busy = isProcessing || renderProgress !== null;
  const stageLabel = renderProgress ? `Rendering page ${renderProgress.current}/${renderProgress.total}...` : stage;
  const progressValue = renderProgress ? Math.round((renderProgress.current / renderProgress.total) * 60) : 60 + progress * 0.4;

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#0284C7"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={busy}
      progress={progressValue}
      stage={stageLabel}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'pages.zip'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to JPG"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file"
          subtitle="Every page becomes a JPG image"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <ImageIcon className="w-5 h-5 text-[#0284C7]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Renders every page at high resolution. A single-page PDF downloads as one .jpg; multiple
            pages are packaged into one .zip.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
