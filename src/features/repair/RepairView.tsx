import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Panel } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { openPdfJsDocument } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { MemoryLimitError, startJob } from '../../services/memoryGuard';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, RepairPayload } from '../../types/worker';

interface RepairViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

async function renderAll(data: Blob, onPage: (i: number, n: number) => void): Promise<NonNullable<RepairPayload['renderedPages']>> {
  const doc = await openPdfJsDocument(data).promise;
  const out: NonNullable<RepairPayload['renderedPages']> = [];
  const job = startJob();
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      job.check();
      onPage(i, doc.numPages);
      try {
        const page = await doc.getPage(i);
        const vp = page.getViewport({ scale: 2 });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d', { alpha: false })!;
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
        canvas.width = 0;
        // Kept as a Blob (the browser pages big ones out to disk) and embedded from there.
        if (blob) out.push({ jpeg: blob, widthPt: vp.width / 2, heightPt: vp.height / 2 });
      } catch {
        // skip pages even pdf.js can't draw
      }
    }
  } finally {
    job.end();
    await memoryManager.destroyPdfDocument(doc);
  }
  return out;
}

export const RepairView: React.FC<RepairViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [fallbackStage, setFallbackStage] = useState<string | null>(null);
  const [fallbackError, setFallbackError] = useState<string | null>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./repair.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const execute = async () => {
    setFallbackError(null);
    const res = await runner.run<RepairPayload>('REPAIR_PDF', { fileBuffer: file.data, fileName: file.name });
    const expected = file.pageCount;
    if (res && (!expected || (res.pageCount ?? 0) >= expected)) return;
    // Structural repair failed or lost pages — rebuild from what pdf.js can render.
    try {
      setFallbackStage('Rendering readable pages…');
      const rendered = await renderAll(file.data, (i, n) => setFallbackStage(`Rendering page ${i} of ${n}…`));
      setFallbackStage(null);
      if (!rendered.length) return;
      if (res && (res.pageCount ?? 0) >= rendered.length) return;
      await runner.run<RepairPayload>('REPAIR_PDF', { fileBuffer: new ArrayBuffer(0), fileName: file.name, renderedPages: rendered });
    } catch (err) {
      setFallbackStage(null);
      if (err instanceof MemoryLimitError) setFallbackError(err.message);
    }
  };

  return (
    <ToolLayout
      tool={getTool('repair')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      isProcessing={runner.layout.isProcessing || !!fallbackStage}
      stage={fallbackStage ?? runner.layout.stage}
      error={fallbackError ?? runner.layout.error}
      resultNote={runner.result?.note}
      actionButtonLabel="Repair"
      onExecuteAction={() => void execute()}
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a damaged PDF" />}
    >
      <Panel className="p-6 space-y-3 text-sm">
        <p>
          First the file’s objects are re-read one by one and written into a clean, consistent structure — that fixes broken
          cross-reference tables, truncated downloads and most “file is damaged” errors while keeping text selectable.
        </p>
        <p className="text-muted text-xs">
          If that loses pages, the pages that can still be displayed are captured as images and assembled into a new PDF, so
          you at least get everything that’s visible back.
        </p>
        {file && !file.pageCount && <p className="text-xs text-warn">This file couldn’t be previewed, so it’s probably damaged — that’s what this tool is for.</p>}
      </Panel>
    </ToolLayout>
  );
};
