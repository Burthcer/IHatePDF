import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { FileText } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { PdfToWordPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToWord',
  title: 'PDF to Word',
  description: 'Extract text into a .docx document, detecting real headings by font size.',
  icon: 'FileText',
  color: '#0284C7',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PdfToWordViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToWordView: React.FC<PdfToWordViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ current: number; total: number } | null>(null);

  const { extractStyledParagraphs } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./pdfToWord.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    setFiles(acceptedFiles.slice(0, 1));
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    setExtractProgress(null);
    resetState();
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const pages = await extractStyledParagraphs(file.rawBuffer, (current, total) =>
        setExtractProgress({ current, total })
      );
      setExtractProgress(null);

      const payload: PdfToWordPayload = { pages, fileName: file.name };
      const res = await runTask<PdfToWordPayload>('PDF_TO_WORD', payload);
      setResult(res);
    } catch (err) {
      setExtractProgress(null);
      console.error('PDF to Word error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  const busy = isProcessing || extractProgress !== null;
  const stageLabel = extractProgress
    ? `Extracting text (page ${extractProgress.current}/${extractProgress.total})...`
    : stage;
  const progressValue = extractProgress
    ? Math.round((extractProgress.current / extractProgress.total) * 50)
    : 50 + progress / 2;

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
      resultFileName={result?.fileName || 'converted_document.docx'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to Word"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file"
          subtitle="Extract its text into a Word document"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <FileText className="w-5 h-5 text-[#0284C7]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Extracts the PDF's text into a .docx document, detecting headings by their real font
            size (large text becomes a Heading, not a plain paragraph) and keeping each paragraph's
            actual size. Per-run color, images, and tables aren't preserved.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
