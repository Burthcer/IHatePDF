import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Presentation } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { BuildPptxPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToPpt',
  title: 'PDF to PowerPoint',
  description: 'Turn every PDF page into a slide in a new .pptx presentation.',
  icon: 'Presentation',
  color: '#F59E0B',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PdfToPptViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToPptView: React.FC<PdfToPptViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);
  const [renderProgress, setRenderProgress] = useState<{ current: number; total: number } | null>(null);

  const { renderAllPageImages } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./buildPptx.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    setFiles(acceptedFiles.slice(0, 1));
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
      const slides = await renderAllPageImages(file.rawBuffer, 1280, (current, total) =>
        setRenderProgress({ current, total })
      );
      setRenderProgress(null);

      const payload: BuildPptxPayload = { slides, fileName: file.name };
      const res = await runTask<BuildPptxPayload>('BUILD_PPTX', payload);
      setResult(res);
    } catch (err) {
      setRenderProgress(null);
      console.error('PDF to PPT error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  const busy = isProcessing || renderProgress !== null;
  const stageLabel = renderProgress
    ? `Rendering page ${renderProgress.current}/${renderProgress.total}...`
    : stage;
  const progressValue = renderProgress
    ? Math.round((renderProgress.current / renderProgress.total) * 50)
    : 50 + progress / 2;

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#F59E0B"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={busy}
      progress={progressValue}
      stage={stageLabel}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'presentation.pptx'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PowerPoint"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file"
          subtitle="Each page becomes one slide"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Presentation className="w-5 h-5 text-[#F59E0B]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Each page is rendered as a full-slide image — this preserves exact visual appearance, but
            slide content is an image, not editable text or shapes.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
