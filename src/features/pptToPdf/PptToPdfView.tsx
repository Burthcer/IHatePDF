import React, { useState } from 'react';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { MonitorPlay } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { PptToPdfPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pptToPdf',
  title: 'PowerPoint to PDF',
  description: 'Convert a .pptx presentation into a PDF, keeping real backgrounds, colors, and layout.',
  icon: 'MonitorPlay',
  color: '#F59E0B',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PptToPdfViewProps {
  onBack: () => void;
}

export const PptToPdfView: React.FC<PptToPdfViewProps> = ({ onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./pptToPdf.worker.ts', import.meta.url), { type: 'module' })
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
      const payload: PptToPdfPayload = { fileBuffer: bufferCopy, fileName: file.name };
      const res = await runTask<PptToPdfPayload>('PPT_TO_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('PPT to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
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
      resultFileName={result?.fileName || 'converted_presentation.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <GenericFileInput
          accept=".pptx"
          onFileAccepted={handleFileAccepted}
          title="Select a PowerPoint file"
          subtitle="Convert a .pptx file into a PDF"
          accentColor="#F59E0B"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <MonitorPlay className="w-5 h-5 text-[#F59E0B]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Redraws each slide with its real background (including gradients), shape fills, tables,
            and text color/bold/italic/position — one PDF page per slide, at the slide's real
            dimensions. Embedded pictures aren't extracted yet, and non-rectangular shapes render as
            rectangles.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
