import React, { useState } from 'react';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { FileType } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { WordToPdfPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'wordToPdf',
  title: 'Word to PDF',
  description: 'Convert a .docx document into a PDF.',
  icon: 'FileType',
  color: '#0284C7',
  category: 'convert',
  acceptedFiles: 'single',
};

interface WordToPdfViewProps {
  onBack: () => void;
}

export const WordToPdfView: React.FC<WordToPdfViewProps> = ({ onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./wordToPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFileAccepted = async (file: File) => {
    const buffer = await file.arrayBuffer();
    setFiles([
      {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        size: file.size,
        pageCount: 0,
        rawBuffer: buffer,
        previewUrls: [],
      },
    ]);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: WordToPdfPayload = { fileBuffer: bufferCopy, fileName: file.name };
      const res = await runTask<WordToPdfPayload>('WORD_TO_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Word to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#0284C7"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'converted_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <GenericFileInput
          accept=".docx"
          onFileAccepted={handleFileAccepted}
          title="Select a Word document"
          subtitle="Convert a .docx file into a PDF"
          accentColor="#0284C7"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <FileType className="w-5 h-5 text-[#0284C7]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            This carries over the document's text content into a new PDF. Bold/italic formatting,
            images, and tables from the original document are not preserved in this version.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
