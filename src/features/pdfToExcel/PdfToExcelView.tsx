import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Table } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { PdfToXlsxPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'pdfToExcel',
  title: 'PDF to Excel',
  description: 'Pull tabular data from a PDF into an Excel spreadsheet.',
  icon: 'Table',
  color: '#10B981',
  category: 'convert',
  acceptedFiles: 'single',
};

interface PdfToExcelViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToExcelView: React.FC<PdfToExcelViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);
  const [extractProgress, setExtractProgress] = useState<{ current: number; total: number } | null>(null);

  const { extractAllTables } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./pdfToXlsx.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    setExtractProgress(null);
    resetState();
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];
    try {
      const pages = await extractAllTables(file.rawBuffer, (current, total) => setExtractProgress({ current, total }));
      setExtractProgress(null);
      const payload: PdfToXlsxPayload = { pages, fileName: file.name };
      const res = await runTask<PdfToXlsxPayload>('PDF_TO_XLSX', payload);
      setResult(res);
    } catch (err) {
      setExtractProgress(null);
      console.error('PDF to Excel error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
  };

  const busy = isProcessing || extractProgress !== null;
  const stageLabel = extractProgress ? `Extracting table data (page ${extractProgress.current}/${extractProgress.total})...` : stage;
  const progressValue = extractProgress ? Math.round((extractProgress.current / extractProgress.total) * 50) : 50 + progress * 0.5;

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#10B981"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={busy}
      progress={progressValue}
      stage={stageLabel}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'spreadsheet.xlsx'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to Excel"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF file" subtitle="Extract tabular data into a spreadsheet" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Table className="w-5 h-5 text-[#10B981]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Recovers rows and columns from each page's text position (PDF has no real table
            structure to read directly) — works best for simple tables, one sheet per page.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
