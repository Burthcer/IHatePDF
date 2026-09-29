import React from 'react';
import { ArrowLeft, FileText, RotateCcw, X } from 'lucide-react';
import { AutoSave } from '../common/AutoSave';
import { resultKey } from '../../services/fileNames';
import { resultSize, type ResultData } from '../../services/toolOutput';
import { Button, IconButton, Notice, ProgressLine, formatBytes } from '../ui';
import { toolIcon } from '../../constants/toolIcons';
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
  /** The result: bytes, or a stored output (temp file / Blob). */
  resultData: ResultData | null;
  resultFileName?: string;
  /** Saves the result; `fileName` is the (possibly user-edited) name to save under. */
  onDownloadResult?: (fileName?: string) => void;
  actionButtonLabel: string;
  onExecuteAction: () => void;
  canExecute?: boolean;
  /** Settings shown in the side panel above the action button. */
  options?: React.ReactNode;
  /** Extra line under the result, e.g. "Saved 42%". */
  resultNote?: React.ReactNode;
  /** Go back to settings after a result (keeps the files). Defaults to clearing the result via onClearFiles. */
  onReset?: () => void;
  /** Hide the loaded-files list (tools that show files in the workspace themselves). */
  hideFileList?: boolean;
  /** Content shown when no file is loaded yet (defaults to children). */
  emptyState?: React.ReactNode;
  /** Legacy prop from the previous design; ignored. */
  accentColor?: string;
  children?: React.ReactNode;
}

export function ToolHeader({ tool, onBack }: { tool: ToolMetadata; onBack: () => void }) {
  const Icon = toolIcon(tool);
  return (
    <div className="space-y-4">
      <button onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink transition-colors">
        <ArrowLeft className="w-3.5 h-3.5" /> All tools
      </button>
      <div className="flex items-start gap-3">
        <div className="mt-0.5 w-9 h-9 shrink-0 rounded border border-line bg-panel flex items-center justify-center">
          <Icon className="w-[18px] h-[18px]" strokeWidth={1.75} />
        </div>
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight leading-tight">{tool.title}</h1>
          <p className="text-sm text-muted mt-0.5">{tool.description}</p>
        </div>
      </div>
    </div>
  );
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
  resultData,
  resultFileName = 'processed_document.pdf',
  onDownloadResult,
  actionButtonLabel,
  onExecuteAction,
  canExecute = true,
  options,
  resultNote,
  onReset,
  hideFileList,
  emptyState,
  children,
}) => {
  if (files.length === 0) {
    return (
      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8 sm:py-10 space-y-8">
        <ToolHeader tool={tool} onBack={onBack} />
        {emptyState ?? children}
      </div>
    );
  }

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      <ToolHeader tool={tool} onBack={onBack} />
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-6 items-start">
        <div className="min-w-0 space-y-4">{children}</div>

        <aside className="lg:sticky lg:top-16 bg-panel border border-line rounded-md divide-y divide-line">
          {!hideFileList && (
            <div className="p-4 space-y-2">
              <div className="flex items-center justify-between">
                <h3 className="label-mono">{files.length === 1 ? 'File' : `Files · ${files.length}`}</h3>
                {files.length > 1 && (
                  <button onClick={onClearFiles} disabled={isProcessing} className="text-2xs text-muted hover:text-danger disabled:opacity-50">
                    Remove all
                  </button>
                )}
              </div>
              <ul className="space-y-1 max-h-48 overflow-y-auto scroll-thin">
                {files.map((f) => (
                  <li key={f.id} className="group flex items-center gap-2 -mx-1 px-1 py-1 rounded hover:bg-hover">
                    <FileText className="w-4 h-4 text-faint shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-medium truncate" title={f.name}>
                        {f.name}
                      </p>
                      <p className="font-mono text-2xs text-muted">
                        {formatBytes(f.size)}
                        {f.pageCount > 0 && ` · ${f.pageCount} pg`}
                        {f.wasProtected && ' · unlocked'}
                      </p>
                    </div>
                    <IconButton
                      label={`Remove ${f.name}`}
                      size="sm"
                      disabled={isProcessing}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100"
                      onClick={() => onRemoveFile(f.id)}
                    >
                      <X className="w-3.5 h-3.5" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {options && !resultData && <div className="p-4 space-y-5">{options}</div>}

          <div className="p-4 space-y-3">
            {isProcessing && <ProgressLine progress={progress} stage={stage} />}

            {error && !isProcessing && (
              <Notice tone="error" title="That didn’t work">
                {error}
              </Notice>
            )}

            {resultData && !isProcessing ? (
              <div className="space-y-3">
                <div>
                  <p className="text-sm font-medium">Done</p>
                  <p className="text-xs text-muted break-all">
                    {resultFileName} · <span className="font-mono">{formatBytes(resultSize(resultData))}</span>
                  </p>
                  {resultNote && <div className="text-xs text-muted mt-1">{resultNote}</div>}
                </div>
                <AutoSave key={resultKey(resultData)} fileName={resultFileName} onSave={(name) => onDownloadResult?.(name)} />
                {onReset && (
                  <Button variant="ghost" size="sm" block icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={onReset}>
                    Change settings and run again
                  </Button>
                )}
              </div>
            ) : (
              <Button variant="primary" size="lg" block onClick={onExecuteAction} disabled={isProcessing || !canExecute} loading={isProcessing}>
                {actionButtonLabel}
              </Button>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};
