import React, { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical, X } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Field, IconButton, Notice, cn, formatBytes } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { MergePayload, ProcessedPdfResult } from '../../types/worker';

interface MergeViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const MergeView: React.FC<MergeViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [covers, setCovers] = useState<Record<string, string>>({});
  const [outputName, setOutputName] = useState('merged');
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const requested = useRef(new Set<string>());
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./merge.worker.ts', import.meta.url), { type: 'module' }));
  const { renderThumbnail } = usePdfRenderer();

  useEffect(() => {
    for (const f of files) {
      if (requested.current.has(f.id)) continue;
      requested.current.add(f.id);
      renderThumbnail(f.rawBuffer, 1, 96)
        .then((url) => setCovers((prev) => ({ ...prev, [f.id]: url })))
        .catch(() => undefined);
    }
  }, [files, renderThumbnail]);

  const change = (next: PDFFile[]) => {
    setFiles(next);
    runner.reset();
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= files.length || from === to) return;
    const next = [...files];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    change(next);
  };

  const totalPages = files.reduce((n, f) => n + f.pageCount, 0);

  const execute = () => {
    const payload: MergePayload = { files: files.map((f) => ({ name: f.name, buffer: f.rawBuffer.slice(0) })), outputName };
    void runner.run('MERGE_PDFS', payload, payload.files.map((f) => f.buffer));
  };

  return (
    <ToolLayout
      tool={getTool('merge')}
      files={files}
      onBack={onBack}
      onClearFiles={() => change([])}
      onRemoveFile={(id) => change(files.filter((f) => f.id !== id))}
      hideFileList
      {...runner.layout}
      actionButtonLabel={files.length < 2 ? 'Add at least 2 files' : `Merge ${files.length} files`}
      onExecuteAction={execute}
      canExecute={files.length >= 2}
      options={
        <>
          <Field label="Output file name" aside=".pdf">
            <input className="input" value={outputName} onChange={(e) => setOutputName(e.target.value.replace(/[\\/:*?"<>|]/g, ''))} />
          </Field>
          <p className="font-mono text-2xs text-muted">
            {files.length} files · {totalPages} pages total
          </p>
        </>
      }
      emptyState={<Dropzone multiple onFilesAccepted={(f) => change([...files, ...f])} title="Choose PDFs to merge" />}
    >
      <div className="bg-panel border border-line rounded-md">
        <div className="flex items-center justify-between px-4 h-10 border-b border-line">
          <h2 className="label-mono">Order</h2>
          <span className="text-2xs text-muted">Drag to reorder — the top file comes first</span>
        </div>
        <ol>
          {files.map((f, i) => (
            <li
              key={f.id}
              draggable
              onDragStart={(e) => {
                setDragIndex(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => {
                e.preventDefault();
                setOverIndex(i);
              }}
              onDragEnd={() => {
                setDragIndex(null);
                setOverIndex(null);
              }}
              onDrop={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (dragIndex !== null) move(dragIndex, i);
                setDragIndex(null);
                setOverIndex(null);
              }}
              className={cn(
                'group flex items-center gap-3 px-3 py-2 border-b border-line last:border-b-0 bg-panel',
                dragIndex === i && 'opacity-40',
                overIndex === i && dragIndex !== null && dragIndex !== i && 'shadow-[inset_0_2px_0_rgb(var(--accent))]'
              )}
            >
              <GripVertical className="w-4 h-4 text-faint cursor-grab shrink-0" />
              <span className="font-mono text-2xs text-muted w-5 text-right">{i + 1}</span>
              <div className="w-10 h-12 shrink-0 bg-white shadow-page flex items-center justify-center overflow-hidden">
                {covers[f.id] && <img src={covers[f.id]} alt="" className="max-w-full max-h-full" />}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium truncate" title={f.name}>
                  {f.name}
                </p>
                <p className="font-mono text-2xs text-muted">
                  {f.pageCount || '?'} pages · {formatBytes(f.size)}
                  {f.wasProtected && ' · unlocked'}
                </p>
              </div>
              <div className="flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
                <IconButton label="Move up" size="sm" disabled={i === 0} onClick={() => move(i, i - 1)}>
                  <ArrowUp className="w-3.5 h-3.5" />
                </IconButton>
                <IconButton label="Move down" size="sm" disabled={i === files.length - 1} onClick={() => move(i, i + 1)}>
                  <ArrowDown className="w-3.5 h-3.5" />
                </IconButton>
                <IconButton label="Remove" size="sm" onClick={() => change(files.filter((x) => x.id !== f.id))}>
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            </li>
          ))}
        </ol>
      </div>
      {files.length === 1 && <Notice>Add one or more files to merge with this one.</Notice>}
      <Dropzone multiple compact onFilesAccepted={(f) => change([...files, ...f])} title="Add more PDFs" />
    </ToolLayout>
  );
};
