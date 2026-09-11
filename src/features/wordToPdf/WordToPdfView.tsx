import React, { useState } from 'react';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { memoryManager } from '../../services/memoryManager';
import { renderDocxToPdf } from './renderDocxToPdf';
import { FileType } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'wordToPdf',
  title: 'Word to PDF',
  description: 'Convert a .docx document into a PDF, preserving layout, styles, and tables.',
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
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);

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
    setError(null);
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    setError(null);
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];
    setIsProcessing(true);
    setError(null);
    setProgress(0);
    try {
      const res = await renderDocxToPdf(file.rawBuffer.slice(0), file.name, (p, s) => {
        setProgress(p);
        setStage(s);
      });
      setResult(res);
    } catch (err) {
      console.error('Word to PDF error:', err);
      setError(err instanceof Error ? err.message : 'Failed to convert Word document to PDF');
    } finally {
      setIsProcessing(false);
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
            Renders the document as real styled HTML (fonts, bold/italic, headings, tables with
            borders, colored callouts from named styles) and rasterizes it page-by-page into the PDF.
            Text picked with an ad-hoc color swatch (not tied to a named style) won't carry its color
            over — that's a limitation of the underlying converter, not this step.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
