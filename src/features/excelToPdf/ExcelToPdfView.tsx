import React, { useState } from 'react';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { FileSpreadsheet } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { XlsxToPdfPayload, OfficeConversionResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'excelToPdf',
  title: 'Excel to PDF',
  description: 'Convert an Excel spreadsheet into a PDF.',
  icon: 'FileSpreadsheet',
  color: '#10B981',
  category: 'convert',
  acceptedFiles: 'single',
};

interface ExcelToPdfViewProps {
  onBack: () => void;
}

export const ExcelToPdfView: React.FC<ExcelToPdfViewProps> = ({ onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [result, setResult] = useState<OfficeConversionResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<OfficeConversionResult>(
      () => new Worker(new URL('./xlsxToPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFileAccepted = async (file: File) => {
    const buffer = await file.arrayBuffer();
    setFiles([
      {
        id: `file_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
        name: file.name,
        size: file.size,
        pageCount: 0,
        rawBuffer: buffer,
        previewUrls: [],
      },
    ]);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    const file = files[0];
    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const payload: XlsxToPdfPayload = { fileBuffer: bufferCopy, fileName: file.name };
      const res = await runTask<XlsxToPdfPayload>('XLSX_TO_PDF', payload, [bufferCopy]);
      setResult(res);
    } catch (err) {
      console.error('Excel to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, result.mimeType);
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
      resultFileName={result?.fileName || 'converted_spreadsheet.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <GenericFileInput
          accept=".xlsx,.xls"
          onFileAccepted={handleFileAccepted}
          title="Select an Excel file"
          subtitle="Convert a .xlsx/.xls file into a PDF"
          accentColor="#10B981"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-[#10B981]" />
            <span>Ready to Convert</span>
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            Draws each sheet as a simple gridded table, one PDF page per screenful of rows. Cell
            colors, fonts, and merged cells aren't preserved — cell values are.
          </p>
        </div>
      )}
    </ToolLayout>
  );
};
