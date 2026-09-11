import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { FileCode } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { PdfToMarkdownPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToMarkdown',
  title: 'PDF to Markdown',
  description: 'Turn a PDF into a Markdown file — perfect for notes and LLMs.',
  icon: 'FileCode',
  color: '#0284C7',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PdfToMarkdownViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToMarkdownView: React.FC<PdfToMarkdownViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ current: number; total: number } | null>(null);

  const { extractAllText } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./pdfToMarkdown.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
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
      const pages = await extractAllText(file.rawBuffer, (current, total) => setExtractProgress({ current, total }));
      setExtractProgress(null);
      const payload: PdfToMarkdownPayload = { pages, fileName: file.name };
      const res = await runTask<PdfToMarkdownPayload>('PDF_TO_MARKDOWN', payload);
      setResult(res);
    } catch (err) {
      setExtractProgress(null);
      console.error('PDF to Markdown error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  const busy = isProcessing || extractProgress !== null;
  const stageLabel = extractProgress ? `Extracting text (page ${extractProgress.current}/${extractProgress.total})...` : stage;
  const progressValue = extractProgress ? Math.round((extractProgress.current / extractProgress.total) * 60) : 60 + progress * 0.4;

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
      resultFileName={result?.fileName || 'document.md'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to Markdown"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF file" subtitle="Extract its text as Markdown" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <FileCode className="w-5 h-5 text-[#0284C7]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Extracts the PDF's text as a clean Markdown file, one section per source page.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
