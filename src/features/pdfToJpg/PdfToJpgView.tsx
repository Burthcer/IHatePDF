import React, { useMemo, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PageThumb } from '../../components/common/PageThumb';
import { Field, Segmented, Slider, Spinner } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { openPdfJsDocument } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { formatPageSet, parsePageRanges, rangesToPages } from '../../services/pageRanges';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { BuildJpgZipPayload, ProcessedPdfResult } from '../../types/worker';

interface PdfToJpgViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

const MAX_PIXELS = 40_000_000; // keep canvases within browser limits

export const PdfToJpgView: React.FC<PdfToJpgViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [format, setFormat] = useState<'jpg' | 'png'>('jpg');
  const [dpi, setDpi] = useState(150);
  const [quality, setQuality] = useState(0.9);
  const [rangeText, setRangeText] = useState('');
  const [rendering, setRendering] = useState<{ progress: number; stage: string } | null>(null);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./pdfToJpg.worker.ts', import.meta.url), { type: 'module' }));

  const selection = useMemo(() => {
    if (!pages.length) return { pages: [] as number[], error: null as string | null };
    if (!rangeText.trim()) return { pages: pages.map((_, i) => i + 1), error: null };
    try {
      return { pages: rangesToPages(parsePageRanges(rangeText, pages.length)), error: null };
    } catch (e) {
      return { pages: [], error: (e as Error).message };
    }
  }, [rangeText, pages]);
  const selected = new Set(selection.pages);

  const execute = async () => {
    const doc = await openPdfJsDocument(file.rawBuffer).promise;
    const images: BuildJpgZipPayload['images'] = [];
    try {
      for (let k = 0; k < selection.pages.length; k++) {
        const n = selection.pages[k];
        setRendering({ progress: (k / selection.pages.length) * 90, stage: `Rendering page ${n}…` });
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        let scale = dpi / 72;
        if (base.width * base.height * scale * scale > MAX_PIXELS) scale = Math.sqrt(MAX_PIXELS / (base.width * base.height));
        const vp = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.ceil(vp.width);
        canvas.height = Math.ceil(vp.height);
        const ctx = canvas.getContext('2d', { alpha: format === 'png' })!;
        if (format === 'jpg') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        await page.render({ canvasContext: ctx, viewport: vp, canvas, background: format === 'png' ? 'rgba(0,0,0,0)' : undefined }).promise;
        const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, format === 'png' ? 'image/png' : 'image/jpeg', quality));
        canvas.width = 0;
        page.cleanup();
        if (blob) images.push({ pageNumber: n, bytes: await blob.arrayBuffer() });
      }
    } finally {
      setRendering(null);
      await memoryManager.destroyPdfDocument(doc);
    }
    const payload: BuildJpgZipPayload = { images, fileName: file.name, ext: format };
    await runner.run('BUILD_JPG_ZIP', payload, images.map((i) => (i as { bytes: ArrayBuffer }).bytes));
  };

  const first = pages[0];

  return (
    <ToolLayout
      tool={getTool('pdfToJpg')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      isProcessing={runner.layout.isProcessing || !!rendering}
      progress={rendering?.progress ?? runner.layout.progress}
      stage={rendering?.stage ?? runner.layout.stage}
      actionButtonLabel={selection.pages.length > 1 ? `Export ${selection.pages.length} images` : 'Export image'}
      onExecuteAction={() => void execute()}
      canExecute={selection.pages.length > 0 && !selection.error}
      options={
        <>
          <Field label="Format">
            <Segmented value={format} onChange={(v) => { setFormat(v); runner.reset(); }} options={[{ value: 'jpg', label: 'JPG' }, { value: 'png', label: 'PNG' }]} />
          </Field>
          <Field label="Resolution">
            <Segmented value={dpi} onChange={(v) => { setDpi(v); runner.reset(); }} size="sm" options={[{ value: 72, label: '72' }, { value: 150, label: '150' }, { value: 300, label: '300' }, { value: 600, label: '600 dpi' }]} />
          </Field>
          {first && (
            <p className="font-mono text-2xs text-muted">
              Page 1 → {Math.round((first.width * dpi) / 72)} × {Math.round((first.height * dpi) / 72)} px
            </p>
          )}
          {format === 'jpg' && <Slider label="Quality" min={0.5} max={1} step={0.05} value={quality} onChange={(v) => { setQuality(v); runner.reset(); }} format={(v) => `${Math.round(v * 100)}%`} />}
          <Field label="Pages" hint={selection.error ?? 'Empty = all pages. Click thumbnails to pick.'}>
            <input className="input font-mono" placeholder="All" value={rangeText} onChange={(e) => { setRangeText(e.target.value); runner.reset(); }} />
          </Field>
          {selection.pages.length > 1 && <p className="text-2xs text-muted">Several images are downloaded together as a ZIP.</p>}
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to export" />}
    >
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6">
          {pages.map((p, i) => (
            <PageThumb
              key={i}
              src={p.url}
              aspect={p.width / p.height}
              label={i + 1}
              selected={!!rangeText.trim() && selected.has(i + 1)}
              dimmed={!selected.has(i + 1)}
              onClick={() => {
                const next = new Set(rangeText.trim() ? selected : []);
                if (next.has(i + 1)) next.delete(i + 1);
                else next.add(i + 1);
                setRangeText(formatPageSet(next));
                runner.reset();
              }}
            />
          ))}
        </div>
      )}
    </ToolLayout>
  );
};
