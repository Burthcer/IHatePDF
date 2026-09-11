import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Archive } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { PdfToPdfaPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToPdfa',
  title: 'PDF to PDF/A',
  description: 'Add archival metadata for long-term PDF/A storage compliance.',
  icon: 'Archive',
  color: '#475569',
  category: 'security',
  acceptedFiles: 'single',
};

interface PdfToPdfaViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToPdfaView: React.FC<PdfToPdfaViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./pdfToPdfa.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
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
      const payload: PdfToPdfaPayload = { fileBuffer: bufferCopy, fileName: file.name };
      const res = await runTask<PdfToPdfaPayload>('PDF_TO_PDFA', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('PDF/A error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#475569"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'archival_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF/A"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF file" subtitle="Tag it for long-term archival storage" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Archive className="w-5 h-5 text-[#475569]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Adds PDF/A-1B identification metadata (the XMP schema archival readers look for). This
            doesn't run a full ISO 19005 conformance check or embed a color profile — for a hard legal
            archival requirement, verify the result with a dedicated PDF/A validator.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
