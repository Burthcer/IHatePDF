import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Minimize2, Zap, Gauge, Sparkles } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { CompressPayload, ProcessedPdfResult } from '../../types/worker';

const COMPRESS_TOOL_METADATA: ToolMetadata = {
  id: 'compress',
  title: 'Compress PDF',
  description: 'Reduce PDF file size while optimizing quality directly in your browser.',
  icon: 'Minimize2',
  color: '#10B981',
  category: 'optimize',
  acceptedFiles: 'single',
};

interface CompressViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const CompressView: React.FC<CompressViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [level, setLevel] = useState<'low' | 'recommended' | 'extreme'>('recommended');
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./compress.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const executeCompress = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: CompressPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        level,
      };

      const res = await runTask<CompressPayload>('COMPRESS_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Compress error:', err);
    }
  };

  const handleDownload = () => {
    if (result) {
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    }
  };

  const originalSize = files[0]?.size || 0;
  const compressedSize = result?.size || 0;
  const savingsPercent =
    originalSize > 0 && compressedSize > 0
      ? Math.max(0, Math.round(((originalSize - compressedSize) / originalSize) * 100))
      : 0;

  return (
    <ToolLayout
      tool={COMPRESS_TOOL_METADATA}
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
      resultFileName={result?.fileName || 'compressed_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Compress PDF"
      onExecuteAction={executeCompress}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file to Compress"
          subtitle="Reduce file size with zero data upload"
        />
      ) : (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-6">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <Minimize2 className="w-5 h-5 text-green-600" />
              <span>Compression Level</span>
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Extreme */}
              <button
                type="button"
                onClick={() => setLevel('extreme')}
                className={`p-5 rounded-2xl border text-left flex flex-col justify-between space-y-3 transition-all ${
                  level === 'extreme'
                    ? 'border-green-600 bg-green-50/50 dark:bg-green-950/20 ring-2 ring-green-600/20'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-sm text-slate-900 dark:text-white">
                    Extreme Compression
                  </span>
                  <Zap className="w-4 h-4 text-green-600" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Aggressively prunes all metadata and streams. Less quality, maximum file size reduction.
                </p>
              </button>

              {/* Recommended */}
              <button
                type="button"
                onClick={() => setLevel('recommended')}
                className={`p-5 rounded-2xl border text-left flex flex-col justify-between space-y-3 transition-all relative ${
                  level === 'recommended'
                    ? 'border-green-600 bg-green-50/50 dark:bg-green-950/20 ring-2 ring-green-600/20'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-sm text-slate-900 dark:text-white">
                    Recommended Compression
                  </span>
                  <Sparkles className="w-4 h-4 text-green-600" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  Optimal balance between visual fidelity and reduced bytes. Perfect for sharing and email.
                </p>
              </button>

              {/* Low */}
              <button
                type="button"
                onClick={() => setLevel('low')}
                className={`p-5 rounded-2xl border text-left flex flex-col justify-between space-y-3 transition-all ${
                  level === 'low'
                    ? 'border-green-600 bg-green-50/50 dark:bg-green-950/20 ring-2 ring-green-600/20'
                    : 'border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center justify-between w-full">
                  <span className="font-bold text-sm text-slate-900 dark:text-white">
                    Low Compression
                  </span>
                  <Gauge className="w-4 h-4 text-green-600" />
                </div>
                <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed">
                  High quality, subtle compression. Reorganizes internal streams while retaining high asset quality.
                </p>
              </button>
            </div>

            {/* Savings indicator if processed */}
            {result && (
              <div className="p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800 rounded-xl flex items-center justify-between text-xs">
                <div>
                  <span className="font-bold text-emerald-800 dark:text-emerald-200">
                    Original:{' '}
                  </span>
                  <span className="text-slate-600 dark:text-slate-400">
                    {(originalSize / 1024 / 1024).toFixed(2)} MB
                  </span>
                  <span className="mx-2 text-slate-400">→</span>
                  <span className="font-bold text-emerald-800 dark:text-emerald-200">New: </span>
                  <span className="text-slate-600 dark:text-slate-400">
                    {(compressedSize / 1024 / 1024).toFixed(2)} MB
                  </span>
                </div>

                <span className="px-2.5 py-1 bg-emerald-200 dark:bg-emerald-800 text-emerald-900 dark:text-emerald-100 font-bold rounded-full">
                  {savingsPercent}% Saved
                </span>
              </div>
            )}
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
