import React, { useState, useRef, useCallback } from 'react';
import { UploadCloud, FileCheck2, AlertCircle, Loader2 } from 'lucide-react';
import { validatePdfHeader, readFileAsArrayBuffer } from '../../services/fileValidator';
import type { PDFFile } from '../../types/pdf';

interface DropzoneProps {
  onFilesAccepted: (files: PDFFile[]) => void;
  multiple?: boolean;
  title?: string;
  subtitle?: string;
  className?: string;
  disabled?: boolean;
}

export const Dropzone: React.FC<DropzoneProps> = ({
  onFilesAccepted,
  multiple = true,
  title = 'Select PDF files',
  subtitle = 'or drop PDF files here',
  className = '',
  disabled = false,
}) => {
  const [isDragging, setIsDragging] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (!fileList || fileList.length === 0 || disabled) return;

      setIsValidating(true);
      setErrorMessage(null);

      const filesToProcess = Array.from(fileList);
      const acceptedFiles: PDFFile[] = [];
      const rejectedFileNames: string[] = [];

      for (const file of filesToProcess) {
        // Enforce magic-byte preflight inspection (%PDF-)
        const isValid = await validatePdfHeader(file);
        if (!isValid) {
          rejectedFileNames.push(file.name);
          continue;
        }

        try {
          const buffer = await readFileAsArrayBuffer(file);
          acceptedFiles.push({
            id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
            name: file.name,
            size: file.size,
            pageCount: 0, // Enriched asynchronously by renderer
            rawBuffer: buffer,
            previewUrls: [],
          });
        } catch {
          rejectedFileNames.push(file.name);
        }
      }

      setIsValidating(false);

      if (rejectedFileNames.length > 0) {
        setErrorMessage(
          `Security Notice: The following file(s) failed preflight magic-byte validation and were rejected: ${rejectedFileNames.join(
            ', '
          )}`
        );
      }

      if (acceptedFiles.length > 0) {
        if (!multiple && acceptedFiles.length > 1) {
          onFilesAccepted([acceptedFiles[0]]);
        } else {
          onFilesAccepted(acceptedFiles);
        }
      }
    },
    [disabled, multiple, onFilesAccepted]
  );

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!disabled) setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    if (e.dataTransfer.files) {
      await processFiles(e.dataTransfer.files);
    }
  };

  const handleInputChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      await processFiles(e.target.files);
      // Reset input value to allow re-uploading identical filename if desired
      e.target.value = '';
    }
  };

  return (
    <div className={`w-full space-y-3 ${className}`}>
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onClick={() => !disabled && !isValidating && fileInputRef.current?.click()}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && !disabled && !isValidating) {
            fileInputRef.current?.click();
          }
        }}
        className={`relative flex flex-col items-center justify-center p-8 sm:p-14 border-2 border-dashed rounded-3xl cursor-pointer transition-all duration-300 ease-out-expo outline-hidden focus:ring-4 focus:ring-brand-500/20 ${
          isDragging
            ? 'border-brand-500 bg-brand-50/80 dark:bg-brand-900/20 scale-[1.015] shadow-soft-lg dark:shadow-soft-dark-lg'
            : 'border-slate-300 dark:border-slate-700 hover:border-brand-400 dark:hover:border-brand-600 bg-white/70 dark:bg-slate-900/50 hover:bg-slate-50 dark:hover:bg-slate-800/50 hover:shadow-soft dark:hover:shadow-soft-dark'
        } ${disabled ? 'opacity-60 cursor-not-allowed' : ''}`}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept=".pdf,application/pdf"
          multiple={multiple}
          onChange={handleInputChange}
          className="hidden"
          disabled={disabled || isValidating}
        />

        <div className="flex flex-col items-center text-center space-y-4 max-w-md">
          <div
            className={`relative w-16 h-16 rounded-2xl flex items-center justify-center shadow-lg transition-transform duration-300 ease-spring ${
              isDragging
                ? 'bg-brand-600 text-white scale-110 animate-pulse-ring'
                : 'bg-brand-50 dark:bg-brand-900/30 text-brand-600 dark:text-brand-400'
            }`}
            style={isDragging ? ({ '--pulse-color': 'rgba(220, 38, 38, 0.4)' } as React.CSSProperties) : undefined}
          >
            {isValidating ? (
              <Loader2 className="w-8 h-8 animate-spin" />
            ) : isDragging ? (
              <FileCheck2 className="w-8 h-8" />
            ) : (
              <UploadCloud className="w-8 h-8" />
            )}
          </div>

          <div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-white transition-colors">
              {isValidating ? 'Validating Magic Bytes (%PDF-)...' : isDragging ? 'Drop it right here' : title}
            </h3>
            <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">{subtitle}</p>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              disabled={disabled || isValidating}
              className="px-6 py-2.5 bg-brand-600 hover:bg-brand-700 text-white font-semibold text-sm rounded-full shadow-md hover:shadow-lg hover:-translate-y-0.5 active:scale-[0.96] active:translate-y-0 transition-all duration-200 ease-out-expo focus:outline-none focus:ring-2 focus:ring-brand-500 focus:ring-offset-2"
            >
              Select Files
            </button>
          </div>

          <p className="text-[11px] text-slate-400 dark:text-slate-500">
            {multiple ? 'Support for single or batch PDF ingestion.' : 'Select one PDF document.'} RAM-only processing.
          </p>
        </div>
      </div>

      {errorMessage && (
        <div className="flex items-start gap-2.5 p-3.5 bg-rose-50 dark:bg-rose-950/40 border border-rose-200 dark:border-rose-900 rounded-xl text-xs text-rose-800 dark:text-rose-300">
          <AlertCircle className="w-4 h-4 shrink-0 text-rose-600 mt-0.5" />
          <p>{errorMessage}</p>
        </div>
      )}
    </div>
  );
};
