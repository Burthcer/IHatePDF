import React, { useEffect, useState } from 'react';
import { Copy, FilePlus2, RotateCw, Trash2, Undo2 } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PageThumb } from '../../components/common/PageThumb';
import { VirtualGrid } from '../../components/common/VirtualGrid';
import { Button, IconButton, Section, Spinner, cn } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { OrganizePayload, ProcessedPdfResult } from '../../types/worker';

interface OrganizeViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

interface Item {
  key: string;
  source: number; // -1 = blank page
  rotate: number;
}

let keySeq = 0;
const nextKey = () => `k${++keySeq}`;

export const OrganizeView: React.FC<OrganizeViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [items, setItems] = useState<Item[]>([]);
  const [history, setHistory] = useState<Item[][]>([]);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);
  const file = files[0];
  const { pages, thumbRef } = usePageThumbnails(file?.data);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./organize.worker.ts', import.meta.url), { type: 'module' }));

  useEffect(() => {
    setItems(pages.map((_, i) => ({ key: nextKey(), source: i, rotate: 0 })));
    setHistory([]);
    // Only when the page count changes (a new file), not on every thumbnail update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  const update = (next: Item[]) => {
    setHistory((h) => [...h.slice(-50), items]);
    setItems(next);
    runner.reset();
  };

  const moveTo = (fromKey: string, toKey: string) => {
    const from = items.findIndex((x) => x.key === fromKey);
    const to = items.findIndex((x) => x.key === toKey);
    if (from < 0 || to < 0 || from === to) return;
    const next = [...items];
    const [it] = next.splice(from, 1);
    next.splice(to, 0, it);
    update(next);
  };

  const unchanged = items.length === pages.length && items.every((it, i) => it.source === i && it.rotate % 360 === 0);

  const execute = () => {
    const payload: OrganizePayload = {
      fileBuffer: file.data,
      fileName: file.name,
      pageOrder: items.map((it) => it.source),
      rotations: items.map((it) => it.rotate),
    };
    void runner.run('ORGANIZE_PAGES', payload);
  };

  const refAspect = pages[0] ? pages[0].width / pages[0].height : 0.707;

  return (
    <ToolLayout
      tool={getTool('organize')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Save new page order"
      onExecuteAction={execute}
      canExecute={items.some((it) => it.source >= 0) && !unchanged}
      options={
        <Section title={`${items.length} pages`}>
          <p className="text-xs text-muted leading-relaxed">
            Drag pages to reorder. Hover a page for rotate, duplicate, insert-blank and delete.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<Undo2 className="w-3.5 h-3.5" />} disabled={!history.length} onClick={() => {
              setItems(history[history.length - 1]);
              setHistory((h) => h.slice(0, -1));
              runner.reset();
            }}>
              Undo
            </Button>
            <Button size="sm" onClick={() => update([...items].reverse())}>
              Reverse order
            </Button>
            <Button size="sm" disabled={unchanged} onClick={() => update(pages.map((_, i) => ({ key: nextKey(), source: i, rotate: 0 })))}>
              Reset
            </Button>
          </div>
        </Section>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to organize" />}
    >
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <VirtualGrid count={items.length} minColWidth={140} rowHeight={196}>
          {(pos) => {
            const it = items[pos];
            const p = it.source >= 0 ? pages[it.source] : null;
            return (
              <div
                key={it.key}
                draggable
                onDragStart={(e) => {
                  setDragKey(it.key);
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setOverKey(it.key);
                }}
                onDragEnd={() => {
                  setDragKey(null);
                  setOverKey(null);
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragKey) moveTo(dragKey, it.key);
                  setDragKey(null);
                  setOverKey(null);
                }}
                className={cn(
                  'group relative rounded cursor-grab active:cursor-grabbing',
                  dragKey === it.key && 'opacity-40',
                  overKey === it.key && dragKey && dragKey !== it.key && 'shadow-[-3px_0_0_rgb(var(--accent))]'
                )}
              >
                <PageThumb
                  src={p?.url}
                  viewRef={it.source >= 0 ? thumbRef(it.source) : undefined}
                  aspect={p ? p.width / p.height : refAspect}
                  rotate={it.rotate}
                  label={
                    <span>
                      {pos + 1}
                      {it.source >= 0 ? (it.source !== pos ? <span className="text-faint"> · was {it.source + 1}</span> : null) : <span className="text-faint"> · blank</span>}
                    </span>
                  }
                />
                <div className="absolute top-1 right-1 flex flex-col gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                  <IconButton label="Rotate" size="sm" className="bg-panel border-line" onClick={() => update(items.map((x) => (x.key === it.key ? { ...x, rotate: x.rotate + 90 } : x)))}>
                    <RotateCw className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label="Duplicate" size="sm" className="bg-panel border-line" onClick={() => update([...items.slice(0, pos + 1), { ...it, key: nextKey() }, ...items.slice(pos + 1)])}>
                    <Copy className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label="Insert blank page after" size="sm" className="bg-panel border-line" onClick={() => update([...items.slice(0, pos + 1), { key: nextKey(), source: -1, rotate: 0 }, ...items.slice(pos + 1)])}>
                    <FilePlus2 className="w-3.5 h-3.5" />
                  </IconButton>
                  <IconButton label="Delete" size="sm" className="bg-panel border-line hover:text-danger" onClick={() => update(items.filter((x) => x.key !== it.key))}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </IconButton>
                </div>
              </div>
            );
          }}
        </VirtualGrid>
      )}
    </ToolLayout>
  );
};
