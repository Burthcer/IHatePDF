import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Wrench } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { RepairPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'repair',
  title: 'Repair PDF',
  description: 'Repair a damaged PDF and recover what can be read from it.',
  icon: 'Wrench',
  color: '#10B981',
  category: 'optimize',
  acceptedFiles: 'single',
};

interface RepairViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const RepairView: React.FC<RepairViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' })
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

  const executeRepair = async () => {
    if (files.length === 0) return;
    const file = files[0];
    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: RepairPayload = { fileBuffer: bufferCopy, fileName: file.name };
      const res = await runTask<RepairPayload>('REPAIR_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Repair error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#10B981"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'repaired_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Repair PDF"
      onExecuteAction={executeRepair}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a damaged PDF file" subtitle="Rebuild its structure and recover what's readable" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Wrench className="w-5 h-5 text-[#10B981]" />
            <span>Ready to Repair</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Re-parses the document tolerantly (skipping malformed objects instead of failing outright)
            and rebuilds a clean file. If the file is too damaged, you'll get a clear error rather than
            a corrupted result.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
