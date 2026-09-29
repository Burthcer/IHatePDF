import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Panel } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { PdfToPdfaPayload, ProcessedPdfResult } from '../../types/worker';

interface PdfToPdfaViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToPdfaView: React.FC<PdfToPdfaViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./pdfToPdfa.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const execute = () => {
    void runner.run<PdfToPdfaPayload>('PDF_TO_PDFA', { fileBuffer: file.data, fileName: file.name });
  };

  return (
    <ToolLayout
      tool={getTool('pdfToPdfa')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      resultNote={runner.result?.note}
      actionButtonLabel="Convert to PDF/A-2b"
      onExecuteAction={execute}
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to archive" />}
    >
      <Panel className="p-6 space-y-3 text-sm">
        <p>What gets done:</p>
        <ul className="list-disc pl-5 space-y-1 text-muted text-xs">
          <li>Encryption, JavaScript, launch actions and file attachments are removed (PDF/A forbids them).</li>
          <li>An sRGB color profile is attached as the output intent, so colors are defined for the long term.</li>
          <li>Archival metadata (XMP with the PDF/A identifier) is written, matching the document properties.</li>
          <li>A permanent file identifier is added.</li>
        </ul>
        <p className="text-xs text-muted">
          Some things can’t be fixed after the fact — most importantly fonts that were never embedded. If any are found, the
          result tells you. For legally required archiving, check the output with a validator such as veraPDF.
        </p>
      </Panel>
    </ToolLayout>
  );
};
