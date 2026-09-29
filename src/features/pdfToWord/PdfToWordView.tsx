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
import type { PageLayout } from '../../services/textLayout';
import { openPdfJsDocument } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { maxCanvasPixels, startJob } from '../../services/memoryGuard';

/** Pictures render at 150 dpi (sharp in Word, small in size). */
const PICTURE_SCALE = 150 / 72;

/**
 * Fills in each picture's pixels: the page is rendered and the picture's area
 * cut out as a JPEG (so whatever pdf.js shows — masks, colour spaces — is
 * exactly what Word gets). Only pages with pictures are rendered.
 */
async function withPictures(data: Blob, pages: PageLayout[], onPage: (done: number, total: number) => void): Promise<PageLayout[]> {
  const todo = pages.filter((p) => p.blocks.some((b) => b.kind === 'image'));
  if (!todo.length) return pages;
  const doc = await openPdfJsDocument(data).promise;
  const job = startJob();
  const byPage = new Map<number, PageLayout>();
  try {
    for (let k = 0; k < todo.length; k++) {
      job.check();
      onPage(k, todo.length);
      const layout = todo[k];
      const page = await doc.getPage(layout.pageNumber);
      let scale = PICTURE_SCALE;
      const base = page.getViewport({ scale: 1 });
      if (base.width * base.height * scale * scale > maxCanvasPixels()) scale = Math.sqrt(maxCanvasPixels() / (base.width * base.height));
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
      const blocks = [];
      for (const b of layout.blocks) {
        if (b.kind !== 'image') {
          blocks.push(b);
          continue;
        }
        const crop = document.createElement('canvas');
        crop.width = Math.max(1, Math.round((b.box.x1 - b.box.x0) * scale));
        crop.height = Math.max(1, Math.round((b.box.y1 - b.box.y0) * scale));
        crop.getContext('2d')!.drawImage(canvas, b.box.x0 * scale, b.box.y0 * scale, crop.width, crop.height, 0, 0, crop.width, crop.height);
        const blob = await new Promise<Blob | null>((r) => crop.toBlob(r, 'image/jpeg', 0.9));
        crop.width = 0;
        blocks.push(blob ? { ...b, data: blob } : b);
      }
      canvas.width = 0;
      page.cleanup();
      byPage.set(layout.pageNumber, { ...layout, blocks });
    }
  } finally {
    job.end();
    await memoryManager.destroyPdfDocument(doc);
  }
  return pages.map((p) => byPage.get(p.pageNumber) ?? p);
}

interface PdfToWordViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const PdfToWordView: React.FC<PdfToWordViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [pageBreaks, setPageBreaks] = useState(true);
  const file = files[0];
  const analysis = useLayoutAnalysis(file?.data);
  const runner = useToolRunner<OfficeConversionResult>(() => new Worker(new URL('./pdfToWord.worker.ts', import.meta.url), { type: 'module' }));
  const [capturing, setCapturing] = useState<string | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);

  const execute = async () => {
    if (!analysis.pages) return;
    setCaptureError(null);
    let layout = analysis.pages;
    try {
      setCapturing('Capturing pictures…');
      layout = await withPictures(file.data, analysis.pages, (done, total) => setCapturing(`Capturing pictures (page ${done + 1} of ${total})…`));
    } catch (err) {
      setCaptureError(err instanceof Error ? err.message : String(err));
      return;
    } finally {
      setCapturing(null);
    }
    const payload: PdfToWordPayload = { pages: [], layout, fileName: file.name, pageBreaks };
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
      isProcessing={runner.layout.isProcessing || !!capturing}
      stage={capturing ?? runner.layout.stage}
      error={captureError ?? runner.layout.error}
      actionButtonLabel="Convert to Word"
      onExecuteAction={() => void execute()}
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
          This PDF looks like a scan (pictures of pages), so there’s no text to convert — the Word file will contain the pages as pictures. Editable text needs OCR first.
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
