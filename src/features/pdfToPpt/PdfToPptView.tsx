import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, Panel, Segmented } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { openPdfJsDocument, type PdfJsSource } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { startJob } from '../../services/memoryGuard';
import { WorkerClient } from '../../services/workerClient';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { BuildPptxPayload, OfficeConversionResult, PptTextBox, PptxSlideImage } from '../../types/worker';

interface PdfToPptViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

async function renderSlides(source: PdfJsSource, width: number, onPage: (i: number, n: number) => void): Promise<PptxSlideImage[]> {
  const doc = await openPdfJsDocument(source).promise;
  const slides: PptxSlideImage[] = [];
  const job = startJob();
  try {
    for (let i = 1; i <= doc.numPages; i++) {
      job.check();
      onPage(i, doc.numPages);
      const page = await doc.getPage(i);
      const base = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(vp.width);
      canvas.height = Math.ceil(vp.height);
      const ctx = canvas.getContext('2d', { alpha: false })!;
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
      slides.push({ dataUrl: canvas.toDataURL('image/jpeg', 0.88), widthPt: base.width, heightPt: base.height });
      canvas.width = 0;
      page.cleanup();
    }
  } finally {
    job.end();
    await memoryManager.destroyPdfDocument(doc);
  }
  return slides;
}

export const PdfToPptView: React.FC<PdfToPptViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [mode, setMode] = useState<'editable' | 'image'>('editable');
  const [prep, setPrep] = useState<{ progress: number; stage: string } | null>(null);
  const [prepError, setPrepError] = useState<string | null>(null);
  const runner = useToolRunner<OfficeConversionResult>(() => new Worker(new URL('./buildPptx.worker.ts', import.meta.url), { type: 'module' }));
  const file = files[0];

  const execute = async () => {
    setPrepError(null);
    let client: WorkerClient | null = null;
    try {
      let source: PdfJsSource = file.data;
      let textBoxes: PptTextBox[][] | undefined;
      if (mode === 'editable') {
        client = new WorkerClient(() => new Worker(new URL('./extract.worker.ts', import.meta.url), { type: 'module' }));
        const res = await client.call<{ background: ArrayBuffer; pages: Array<{ boxes: PptTextBox[] }> }>('EXTRACT_FOR_PPT', { buffer: file.data }, [], (p, stage) =>
          setPrep({ progress: p * 0.4, stage })
        );
        source = res.background;
        textBoxes = res.pages.map((p) => p.boxes);
      }
      const slides = await renderSlides(source, 1600, (i, n) => setPrep({ progress: 40 + (i / n) * 55, stage: `Rendering slide ${i} of ${n}…` }));
      setPrep(null);
      const payload: BuildPptxPayload = { slides, textBoxes, fileName: file.name };
      await runner.run('BUILD_PPTX', payload);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    } finally {
      client?.terminate();
      setPrep(null);
    }
  };

  return (
    <ToolLayout
      tool={getTool('pdfToPpt')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      isProcessing={runner.layout.isProcessing || !!prep}
      progress={prep ? prep.progress : runner.layout.progress}
      stage={prep ? prep.stage : runner.layout.stage}
      error={prepError ?? runner.layout.error}
      actionButtonLabel="Convert to PowerPoint"
      onExecuteAction={() => void execute()}
      options={
        <Field label="Slides">
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              runner.reset();
            }}
            options={[
              { value: 'editable', label: 'Editable text' },
              { value: 'image', label: 'Images only' },
            ]}
          />
        </Field>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to convert" />}
    >
      <Panel className="p-6 space-y-2 text-sm">
        {mode === 'editable' ? (
          <>
            <p>Each page becomes a slide. The text is taken out of the page and put back as real PowerPoint text boxes — same position, size, color and weight — over a background with everything else.</p>
            <p className="text-xs text-muted">If a font isn’t installed on the computer opening the deck, PowerPoint substitutes a similar one.</p>
          </>
        ) : (
          <p>Each page becomes a picture on its own slide. Looks exactly like the PDF, but the text can’t be edited.</p>
        )}
      </Panel>
    </ToolLayout>
  );
};
