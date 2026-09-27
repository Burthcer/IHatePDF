import React, { useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { Button, cn } from '../ui';

interface GenericFileInputProps {
  accept: string;
  onFileAccepted?: (file: File) => void;
  onFilesAccepted?: (files: File[]) => void;
  multiple?: boolean;
  title: string;
  subtitle?: string;
  /** Kept for compatibility with older call sites; unused. */
  accentColor?: string;
  compact?: boolean;
}

/** File picker / drop target for non-PDF inputs (.docx, .pptx, images…). */
export const GenericFileInput: React.FC<GenericFileInputProps> = ({ accept, onFileAccepted, onFilesAccepted, multiple, title, subtitle, compact }) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? []);
    if (!files.length) return;
    if (onFilesAccepted) onFilesAccepted(multiple ? files : files.slice(0, 1));
    else onFileAccepted?.(files[0]);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => inputRef.current?.click()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          inputRef.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setIsDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        handle(e.dataTransfer.files);
      }}
      className={cn(
        'group flex flex-col items-center justify-center text-center border border-dashed rounded-md cursor-pointer transition-colors',
        compact ? 'px-6 py-8' : 'px-6 py-14',
        isDragging ? 'border-accent bg-accent-soft' : 'border-line-strong bg-panel hover:border-muted'
      )}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          handle(e.target.files);
          e.target.value = '';
        }}
      />
      <FileUp className={cn('w-6 h-6 mb-3', isDragging ? 'text-accent' : 'text-faint group-hover:text-muted')} />
      <p className="text-sm font-medium text-ink">{isDragging ? 'Drop to add' : title}</p>
      <p className="text-xs text-muted mt-1">{subtitle || 'or drag it here'}</p>
      {!compact && (
        <Button size="sm" className="mt-4 pointer-events-none" tabIndex={-1}>
          Browse…
        </Button>
      )}
    </div>
  );
};
