import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Unlock, KeyRound } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { UnlockPayload, ProcessedPdfResult } from '../../types/worker';

const UNLOCK_TOOL_METADATA: ToolMetadata = {
  id: 'unlock',
  title: 'Unlock PDF',
  description: 'Remove password protection, restrictions, and permissions from PDF documents.',
  icon: 'Unlock',
  color: '#475569',
  category: 'security',
  acceptedFiles: 'single',
};

interface UnlockViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const UnlockView: React.FC<UnlockViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./unlock.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setPassword('');
    setResult(null);
    resetState();
  };

  const executeUnlock = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: UnlockPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        password: password || undefined,
      };

      const res = await runTask<UnlockPayload>('UNLOCK_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Unlock error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  return (
    <ToolLayout
      tool={UNLOCK_TOOL_METADATA}
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
      resultFileName={result?.fileName || 'unlocked_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Unlock PDF"
      onExecuteAction={executeUnlock}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Unlock"
          subtitle="Remove restrictions and encryption without server uploads"
        />
      ) : (
        <div className="space-y-6 max-w-xl mx-auto">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-6">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Unlock className="w-5 h-5 text-rose-600" />
              <span>Unlock Document</span>
            </h3>

            <div className="space-y-4">
              <div>
                <label
                  htmlFor="unlock-password"
                  className="block text-xs font-bold uppercase tracking-wider text-slate-600 dark:text-slate-400 mb-1.5"
                >
                  Password (Optional / If Prompted)
                </label>
                <div className="relative">
                  <input
                    id="unlock-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter document password if protected..."
                    className="w-full px-4 py-2.5 bg-slate-50 dark:bg-slate-800/80 border border-slate-300 dark:border-slate-700 rounded-xl text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-rose-500"
                  />
                  <KeyRound className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
                </div>
              </div>

              <div className="p-3 bg-slate-100 dark:bg-slate-800/60 rounded-xl text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                Many PDFs have printing or editing restrictions that can be unlocked directly without requiring a password. If the PDF has an open password, provide it above.
              </div>
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
