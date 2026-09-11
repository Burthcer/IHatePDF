import React from 'react';
import { ArrowLeft, Trash2, Download, AlertCircle, CheckCircle2 } from 'lucide-react';
import { ProgressBar } from '../common/ProgressBar';
import type { ToolMetadata, PDFFile } from '../../types/pdf';

interface ToolLayoutProps {
  tool: ToolMetadata;
  files: PDFFile[];
  onBack: () => void;
  onClearFiles: () => void;
  onRemoveFile: (id: string) => void;
  isProcessing: boolean;
  progress: number;
  stage: string;
  error: string | null;
  resultBuffer: ArrayBuffer | null;
  resultFileName?: string;
  onDownloadResult?: () => void;
  actionButtonLabel: string;
  onExecuteAction: () => void;
  canExecute?: boolean;
  /** Hex color for this tool's accent (action button, badges). Falls back to the brand red. */
  accentColor?: string;
  children?: React.ReactNode;
}

function hexToRgba(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export const ToolLayout: React.FC<ToolLayoutProps> = ({
  tool,
  files,
  onBack,
  onClearFiles,
  onRemoveFile,
  isProcessing,
  progress,
  stage,
  error,
  resultBuffer,
  resultFileName = 'processed_document.pdf',
  onDownloadResult,
  actionButtonLabel,
  onExecuteAction,
  canExecute = true,
  accentColor = '#E53E3E',
  children,
}) => {
  return (
    <div className="w-full max-w-[1600px] mx-auto px-4 py-6 space-y-6">
      {/* Compact Tool Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
        <div className="flex items-start gap-3">
          <button
            onClick={onBack}
            className="mt-0.5 p-2 rounded-full text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white bg-white dark:bg-slate-900 shadow-soft dark:shadow-soft-dark hover:-translate-x-0.5 active:scale-[0.92] transition-all duration-200 ease-out-expo"
            title="Back to Catalog"
          >
            <ArrowLeft className="w-4 h-4" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-xl sm:text-2xl font-bold text-slate-900 dark:text-white">
                {tool.title}
              </h1>
              {tool.badge && (
                <span
                  className="text-[11px] px-2.5 py-0.5 rounded-full font-semibold text-white shadow-sm"
                  style={{ backgroundColor: accentColor }}
                >
                  {tool.badge}
                </span>
              )}
            </div>
            <p className="text-sm text-slate-600 dark:text-slate-400 mt-0.5">{tool.description}</p>
          </div>
        </div>

        {files.length > 0 && (
          <button
            onClick={onClearFiles}
            disabled={isProcessing}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold text-slate-600 dark:text-slate-300 bg-white dark:bg-slate-900 shadow-soft dark:shadow-soft-dark hover:text-rose-600 dark:hover:text-rose-400 rounded-full active:scale-[0.96] transition-all duration-200 self-start sm:self-auto disabled:opacity-50"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>Clear All ({files.length})</span>
          </button>
        )}
      </div>

      {/* Before any file is loaded there's nothing for a sidebar to show yet —
          skip the two-pane grid so the dropzone centers on the full width
          instead of being squeezed into a reserved-but-empty left column. */}
      {files.length === 0 ? (
        <div className="max-w-3xl mx-auto">{children}</div>
      ) : (
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-6 items-start">
        {/* Central Staging Area */}
        <div className="min-w-0 space-y-6">{children}</div>

        {/* Right Configuration Sidebar */}
        <aside className="space-y-4 lg:sticky lg:top-20">
          {files.length > 0 && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 shadow-soft dark:shadow-soft-dark animate-float-in">
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                Loaded Documents ({files.length})
              </h4>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {files.map((file) => (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-2.5 bg-slate-50 dark:bg-slate-800/60 rounded-xl text-xs"
                  >
                    <div className="truncate mr-2">
                      <p className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                        {file.name}
                      </p>
                      <p className="text-[11px] text-slate-400">
                        {(file.size / 1024 / 1024).toFixed(2)} MB
                        {file.pageCount > 0 ? ` • ${file.pageCount} pages` : ''}
                      </p>
                    </div>
                    <button
                      onClick={() => onRemoveFile(file.id)}
                      disabled={isProcessing}
                      className="p-1 text-slate-400 hover:text-rose-600 rounded-md active:scale-90 transition-all shrink-0"
                      title="Remove file"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {isProcessing && (
            <div className="bg-white dark:bg-slate-900 rounded-2xl p-4 shadow-soft dark:shadow-soft-dark animate-float-in">
              <ProgressBar progress={progress} stage={stage} accentColor={accentColor} />
            </div>
          )}

          {error && (
            <div className="p-4 bg-rose-50 dark:bg-rose-950/40 rounded-2xl shadow-soft dark:shadow-soft-dark flex items-start gap-2.5 text-rose-900 dark:text-rose-200 text-sm animate-float-in">
              <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-semibold text-sm">Operation Failed</p>
                <p className="text-xs text-rose-700 dark:text-rose-300 mt-0.5">{error}</p>
              </div>
            </div>
          )}

          {resultBuffer && !isProcessing && (
            <div className="p-4 bg-emerald-50 dark:bg-emerald-950/40 rounded-2xl shadow-soft dark:shadow-soft-dark space-y-3 animate-float-in">
              <div className="flex items-center gap-2.5">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-300 shrink-0" />
                <div>
                  <h3 className="font-bold text-slate-900 dark:text-white text-sm">Ready for Download</h3>
                  <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                    {(resultBuffer.byteLength / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              </div>
              <button
                onClick={onDownloadResult}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-sm rounded-xl shadow-md hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.97] active:translate-y-0 transition-all duration-200 ease-out-expo"
              >
                <Download className="w-4 h-4" />
                <span className="truncate">Download {resultFileName}</span>
              </button>
            </div>
          )}

          {files.length > 0 && !resultBuffer && (
            <button
              onClick={onExecuteAction}
              disabled={isProcessing || !canExecute}
              className="w-full px-5 py-3.5 text-white font-bold text-sm rounded-2xl hover:-translate-y-0.5 active:scale-[0.98] active:translate-y-0 transition-all duration-200 ease-out-expo focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:translate-y-0 disabled:hover:shadow-none"
              style={{
                backgroundColor: accentColor,
                boxShadow: isProcessing || !canExecute ? undefined : `0 10px 24px -8px ${hexToRgba(accentColor, 0.55)}`,
              }}
            >
              {actionButtonLabel}
            </button>
          )}
        </aside>
      </div>
      )}
    </div>
  );
};
