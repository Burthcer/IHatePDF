import React, { useRef, useState } from 'react';
import { UploadCloud, FileCheck2 } from 'lucide-react';

interface GenericFileInputProps {
  accept: string;
  onFileAccepted: (file: File) => void;
  title: string;
  subtitle?: string;
  accentColor?: string;
}

/**
 * A Dropzone-alike for non-PDF inputs (.docx, .pptx) — the shared
 * `Dropzone` component validates `%PDF-` magic bytes, which doesn't apply
 * here; this just checks the file extension and hands back the raw `File`.
 */
export const GenericFileInput: React.FC<GenericFileInputProps> = ({
  accept,
  onFileAccepted,
  title,
  subtitle = '',
  accentColor = '#0284C7',
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFile = (file: File | undefined) => {
    if (file) onFileAccepted(file);
  };

  return (
    <div className="w-full space-y-3">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={(e) => {
          e.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        onClick={() => inputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click();
        }}
        className="relative flex flex-col items-center justify-center p-8 sm:p-12 border-2 border-dashed rounded-2xl cursor-pointer transition-colors outline-hidden"
        style={{
          borderColor: isDragging ? accentColor : undefined,
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept={accept}
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = '';
          }}
          className="hidden"
        />
        <div className="flex flex-col items-center text-center space-y-4 max-w-md">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center text-white shadow-md"
            style={{ backgroundColor: accentColor }}
          >
            {isDragging ? <FileCheck2 className="w-8 h-8" /> : <UploadCloud className="w-8 h-8" />}
          </div>
          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white">{title}</h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>
          </div>
          <button
            type="button"
            className="px-6 py-2.5 text-white font-semibold text-sm rounded-xl shadow-sm"
            style={{ backgroundColor: accentColor }}
          >
            Select File
          </button>
          <p className="text-[11px] text-slate-400 dark:text-slate-500">RAM-only processing.</p>
        </div>
      </div>
    </div>
  );
};
