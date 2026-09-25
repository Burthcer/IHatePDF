import React, { useState } from 'react';
import { RotateCcw, RotateCw } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PageThumb } from '../../components/common/PageThumb';
import { Button, IconButton, Section, Spinner } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, RotatePayload } from '../../types/worker';

interface RotateViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const RotateView: React.FC<RotateViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [turns, setTurns] = useState<Record<number, number>>({});
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./rotate.worker.ts', import.meta.url), { type: 'module' }));

  const rotate = (indices: number[], delta: number) => {
    setTurns((prev) => {
      const next = { ...prev };
      indices.forEach((i) => (next[i] = (next[i] ?? 0) + delta));
      return next;
    });
    runner.reset();
  };
  const targets = () => (selected.size ? [...selected] : pages.map((_, i) => i));
  const changed = Object.entries(turns).filter(([, d]) => ((d % 360) + 360) % 360 !== 0);

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: RotatePayload = {
      fileBuffer: buffer,
      fileName: file.name,
      rotations: changed.map(([i, d]) => ({ pageIndex: Number(i), degrees: ((d % 360) + 360) % 360 })),
    };
    void runner.run('ROTATE_PAGES', payload, [buffer]);
  };

  return (
    <ToolLayout
      tool={getTool('rotate')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel={changed.length ? `Rotate ${changed.length} page${changed.length === 1 ? '' : 's'}` : 'Rotate pages'}
      onExecuteAction={execute}
      canExecute={changed.length > 0}
      options={
        <Section title={selected.size ? `${selected.size} selected` : 'All pages'}>
          <div className="flex gap-2">
            <Button size="sm" icon={<RotateCcw className="w-3.5 h-3.5" />} onClick={() => rotate(targets(), -90)}>
              Left
            </Button>
            <Button size="sm" icon={<RotateCw className="w-3.5 h-3.5" />} onClick={() => rotate(targets(), 90)}>
              Right
            </Button>
            <Button size="sm" onClick={() => rotate(targets(), 180)}>
              180°
            </Button>
          </div>
          <p className="text-xs text-muted">Click pages to select some; with nothing selected the buttons apply to every page.</p>
          <div className="flex gap-3 text-xs">
            <button className="text-muted hover:text-ink" onClick={() => setSelected(new Set(pages.map((_, i) => i)))}>
              Select all
            </button>
            {selected.size > 0 && (
              <button className="text-muted hover:text-ink" onClick={() => setSelected(new Set())}>
                Clear selection
              </button>
            )}
            {changed.length > 0 && (
              <button className="text-muted hover:text-ink" onClick={() => setTurns({})}>
                Reset rotations
              </button>
            )}
          </div>
        </Section>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to rotate" />}
    >
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-x-4 gap-y-6">
          {pages.map((p, i) => (
            <PageThumb
              key={i}
              src={p.url}
              aspect={p.width / p.height}
              rotate={turns[i] ?? 0}
              selected={selected.has(i)}
              onClick={() =>
                setSelected((prev) => {
                  const next = new Set(prev);
                  if (next.has(i)) next.delete(i);
                  else next.add(i);
                  return next;
                })
              }
              label={i + 1}
            >
              <div className="absolute bottom-1 right-1 flex gap-0.5 opacity-0 hover:opacity-100 focus-within:opacity-100 [div:hover>&]:opacity-100">
                <IconButton label="Rotate left" size="sm" className="bg-panel border-line" onClick={(e) => { e.stopPropagation(); rotate([i], -90); }}>
                  <RotateCcw className="w-3.5 h-3.5" />
                </IconButton>
                <IconButton label="Rotate right" size="sm" className="bg-panel border-line" onClick={(e) => { e.stopPropagation(); rotate([i], 90); }}>
                  <RotateCw className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            </PageThumb>
          ))}
        </div>
      )}
    </ToolLayout>
  );
};
