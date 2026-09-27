import React, { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useFileIngestion, RejectedFilesNotice } from '../../hooks/useFileIngestion';
import { Button, Spinner, cn } from '../ui';
import type { PDFFile } from '../../types/pdf';

interface DropzoneProps {
  onFilesAccepted: (files: PDFFile[]) => void;
  multiple?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  disabled?: boolean;
  /** Don't prompt for passwords; hand encrypted files over as-is (Unlock/Protect). */
  keepEncrypted?: boolean;
  compact?: boolean;
}

export const Dropzone: React.FC<DropzoneProps> = ({
  onFilesAccepted,
  multiple = true,
  title,
  subtitle,
  className,
  disabled = false,
  keepEncrypted,
  compact,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { ingest, busy, rejected, clearRejected, dialogs } = useFileIngestion({ keepEncrypted });

  const process = async (list: FileList | File[]) => {
    if (disabled) return;
    const files = await ingest(multiple ? list : Array.from(list).slice(0, 1));
    if (files.length) onFilesAccepted(files);
  };

  return (
    <div className={cn('w-full space-y-3', className)}>
      <div
        role="button"
        tabIndex={0}
        aria-disabled={disabled}
        onClick={() => !disabled && !busy && inputRef.current?.click()}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled && !busy) {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setIsDragging(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setIsDragging(false);
          if (e.dataTransfer.files?.length) void process(e.dataTransfer.files);
        }}
        className={cn(
          'group relative flex flex-col items-center justify-center text-center border border-dashed rounded-md cursor-pointer transition-colors',
          compact ? 'px-6 py-8' : 'px-6 py-14',
          isDragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel hover:border-muted',
          disabled && 'opacity-50 cursor-not-allowed'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple={multiple}
          className="hidden"
          disabled={disabled || busy}
          onChange={(e) => {
            if (e.target.files?.length) void process(e.target.files);
            e.target.value = '';
          }}
        />
        {busy ? <Spinner className="w-6 h-6 mb-3" /> : <FileUp className={cn('w-6 h-6 mb-3', isDragging ? 'text-accent' : 'text-faint group-hover:text-muted')} />}
        <p className="text-sm font-medium text-ink">{busy ? 'Reading files…' : isDragging ? 'Drop to add' : title ?? (multiple ? 'Choose PDF files' : 'Choose a PDF')}</p>
        <p className="text-xs text-muted mt-1">{subtitle ?? 'or drag them here'}</p>
        {!compact && (
          <Button variant="secondary" size="sm" className="mt-4 pointer-events-none" tabIndex={-1}>
            Browse…
          </Button>
        )}
      </div>
      <RejectedFilesNotice rejected={rejected} onDismiss={clearRejected} />
      {dialogs}
    </div>
  );
};
