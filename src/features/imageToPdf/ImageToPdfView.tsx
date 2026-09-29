import React, { useState } from 'react';
import { GripVertical, X } from 'lucide-react';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, IconButton, Notice, Segmented, cn } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { assertDecodable, prepareImage, type PreparedImage } from '../../services/imagePrep';
import { MemoryLimitError } from '../../services/memoryGuard';

/** Above this, an image isn't shown: the browser would decode all of it just to draw a small preview. */
const PREVIEW_MAX_PIXELS = 40_000_000;
const tooBigToPreview = (i: { width?: number; height?: number }) => !!i.width && !!i.height && i.width * i.height > PREVIEW_MAX_PIXELS;
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ImagePageMargin, ImagePageOrientation, ImagePageSize, ImagesToPdfPayload, ProcessedPdfResult } from '../../types/worker';

interface ImageToPdfViewProps {
  onBack: () => void;
}

interface Item extends PreparedImage {
  id: string;
  name: string;
}

export const ImageToPdfView: React.FC<ImageToPdfViewProps> = ({ onBack }) => {
  const [items, setItems] = useState<Item[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [tooBig, setTooBig] = useState<string | null>(null);
  const [orientation, setOrientation] = useState<ImagePageOrientation>('auto');
  const [margin, setMargin] = useState<ImagePageMargin>('small');
  const [pageSize, setPageSize] = useState<ImagePageSize>('a4');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./imagesToPdf.worker.ts', import.meta.url), { type: 'module' }));

  const add = async (files: File[]) => {
    const bad: string[] = [];
    const ready: Item[] = [];
    for (const f of files) {
      try {
        ready.push({ ...(await prepareImage(f)), id: crypto.randomUUID(), name: f.name });
      } catch (err) {
        if (err instanceof MemoryLimitError) setTooBig(`${f.name}: ${err.message}`);
        else bad.push(f.name);
      }
    }
    setFailed(bad);
    setItems((prev) => [...prev, ...ready]);
    runner.reset();
  };

  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    setItems(next);
    runner.reset();
  };

  const execute = () => {
    // PNGs are decoded whole to go into the PDF (the image, its alpha and the
    // compressed copy): one that doesn't fit the memory budget is refused up front.
    setTooBig(null);
    for (const i of items) {
      if (i.type !== 'png') continue;
      try {
        assertDecodable(i.width && i.height ? { width: i.width, height: i.height } : null, 3);
      } catch (err) {
        setTooBig(`${i.name}: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    const images = items.map((i) => ({ bytes: i.data, type: i.type }));
    const payload: ImagesToPdfPayload = { images, orientation, margin, pageSize, fileName: items.length === 1 ? items[0].name : 'images.pdf' };
    void runner.run('IMAGES_TO_PDF', payload);
  };

  // ToolLayout keys its two-pane mode off `files`; images aren't PDFFiles, so adapt them.
  const asFiles: PDFFile[] = items.map((i) => ({ id: i.id, name: i.name, size: i.data.size, pageCount: 1, data: i.data, previewUrls: tooBigToPreview(i) ? [] : [i.url] }));

  return (
    <ToolLayout
      tool={getTool('imageToPdf')}
      files={asFiles}
      onBack={onBack}
      onClearFiles={() => setItems([])}
      onRemoveFile={(id) => setItems((prev) => prev.filter((i) => i.id !== id))}
      hideFileList
      {...runner.layout}
      actionButtonLabel={`Create PDF (${items.length} page${items.length === 1 ? '' : 's'})`}
      onExecuteAction={execute}
      canExecute={items.length > 0}
      options={
        <>
          <Field label="Page size">
            <Segmented value={pageSize} onChange={(v) => { setPageSize(v); runner.reset(); }} size="sm" options={[{ value: 'a4', label: 'A4' }, { value: 'letter', label: 'Letter' }, { value: 'fit', label: 'Fit image' }]} />
          </Field>
          {pageSize !== 'fit' && (
            <Field label="Orientation">
              <Segmented value={orientation} onChange={(v) => { setOrientation(v); runner.reset(); }} size="sm" options={[{ value: 'auto', label: 'Auto' }, { value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
            </Field>
          )}
          <Field label="Margin">
            <Segmented value={margin} onChange={(v) => { setMargin(v); runner.reset(); }} size="sm" options={[{ value: 'none', label: 'None' }, { value: 'small', label: 'Small' }, { value: 'big', label: 'Large' }]} />
          </Field>
        </>
      }
      emptyState={
        <GenericFileInput accept="image/*" multiple onFilesAccepted={(f) => void add(f)} title="Choose images" subtitle="JPG, PNG, WebP, GIF, BMP… or drag them here" />
      }
    >
      {failed.length > 0 && <Notice tone="warn">Couldn’t read: {failed.join(', ')}</Notice>}
      {tooBig && <Notice tone="warn">{tooBig}</Notice>}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {items.map((it, i) => (
          <div
            key={it.id}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              if (dragIndex !== null) move(dragIndex, i);
              setDragIndex(null);
            }}
            className={cn('group relative bg-panel border border-line rounded p-2 cursor-grab', dragIndex === i && 'opacity-40')}
          >
            <div className="aspect-[3/4] flex items-center justify-center bg-sunken overflow-hidden">
              {tooBigToPreview(it) ? (
                // Showing it would decode every pixel (over a gigabyte for a 300-megapixel image).
                <span className="text-2xs text-muted text-center px-2">{Math.round((it.width! * it.height!) / 1e6)} MP image — too large to preview</span>
              ) : (
                <img src={it.url} alt="" className="max-w-full max-h-full object-contain" draggable={false} />
              )}
            </div>
            <div className="flex items-center gap-1 mt-1.5">
              <GripVertical className="w-3 h-3 text-faint shrink-0" />
              <span className="font-mono text-2xs text-muted">{i + 1}</span>
              <span className="text-2xs truncate flex-1" title={it.name}>
                {it.name}
              </span>
            </div>
            <IconButton label="Remove" size="sm" className="absolute top-1 right-1 bg-panel border-line opacity-0 group-hover:opacity-100" onClick={() => setItems((prev) => prev.filter((x) => x.id !== it.id))}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        ))}
      </div>
      <GenericFileInput accept="image/*" multiple compact onFilesAccepted={(f) => void add(f)} title="Add more images" />
    </ToolLayout>
  );
};
