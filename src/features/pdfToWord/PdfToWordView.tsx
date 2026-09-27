import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { StructurePreview } from '../../components/convert/StructurePreview';
import { Notice, ProgressLine, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { useLayoutAnalysis } from '../../hooks/useLayoutAnalysis';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { OfficeConversionResult, PdfToWordPayload } from '../../types/worker';

interface PdfToWordViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToWordView: React.FC<PdfToWordViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [pageBreaks, setPageBreaks] = useState(true);
  const file = files[0];
  const analysis = useLayoutAnalysis(file?.rawBuffer);
  const runner = useToolRunner<OfficeConversionResult>(() => new Worker(new URL('./pdfToWord.worker.ts', import.meta.url), { type: 'module' }));

  const execute = () => {
    if (!analysis.pages) return;
    const payload: PdfToWordPayload = { pages: [], layout: analysis.pages, fileName: file.name, pageBreaks };
    void runner.run('PDF_TO_WORD', payload);
  };

  return (
    <ToolLayout
      tool={getTool('pdfToWord')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Convert to Word"
      onExecuteAction={execute}
      canExecute={!!analysis.pages}
      options={<Toggle checked={pageBreaks} onChange={(v) => { setPageBreaks(v); runner.reset(); }} label="Keep page breaks" hint="Start each PDF page on a new Word page." />}
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to convert" />}
    >
      {analysis.error && <Notice tone="error">{analysis.error}</Notice>}
      {!analysis.pages && !analysis.error && (
        <div className="max-w-sm">
          <ProgressLine progress={analysis.progress ? (analysis.progress.done / analysis.progress.total) * 100 : 0} stage={analysis.progress ? `Reading page ${analysis.progress.done} of ${analysis.progress.total}…` : 'Reading document…'} />
        </div>
      )}
      {analysis.pages && !analysis.hasText && (
        <Notice tone="warn" title="No text found">
          This PDF looks like a scan (pictures of pages), so there’s no text to convert. It needs OCR first.
        </Notice>
      )}
      {analysis.pages && analysis.hasText && (
        <>
          <p className="text-xs text-muted">Preview of the recovered structure — headings, paragraphs, lists and tables become real Word elements.</p>
          <StructurePreview pages={analysis.pages} />
        </>
      )}
    </ToolLayout>
  );
};
