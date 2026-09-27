import React, { useMemo, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PageThumb } from '../../components/common/PageThumb';
import { Field, Notice, Segmented, Spinner } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { formatPageSet, parsePageRanges, rangesToPages } from '../../services/pageRanges';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, SplitPayload } from '../../types/worker';

type Mode = 'extract' | 'ranges' | 'every' | 'all';

interface SplitViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const SplitView: React.FC<SplitViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [mode, setMode] = useState<Mode>('extract');
  const [rangeText, setRangeText] = useState('1');
  const [everyN, setEveryN] = useState(2);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer);
  const total = pages.length || file?.pageCount || 0;
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' }));

  const parsed = useMemo(() => {
    if (!total) return { ranges: [], error: null as string | null };
    try {
      return { ranges: parsePageRanges(rangeText, total), error: null };
    } catch (e) {
      return { ranges: [], error: (e as Error).message };
    }
  }, [rangeText, total]);

  const groups: number[][] = useMemo(() => {
    if (!total) return [];
    if (mode === 'all') return Array.from({ length: total }, (_, i) => [i]);
    if (mode === 'every') {
      const n = Math.max(1, everyN);
      const out: number[][] = [];
      for (let i = 0; i < total; i += n) out.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
      return out;
    }
    if (mode === 'ranges') return parsed.ranges.map((r) => rangesToPages([r]).map((p) => p - 1));
    return [rangesToPages(parsed.ranges).map((p) => p - 1)];
  }, [mode, everyN, parsed, total]);

  const selected = useMemo(() => new Set(mode === 'extract' || mode === 'ranges' ? rangesToPages(parsed.ranges) : []), [mode, parsed]);
  const groupOf = useMemo(() => {
    const m = new Map<number, number>();
    groups.forEach((g, gi) => g.forEach((p) => m.set(p, gi)));
    return m;
  }, [groups]);

  const togglePage = (page: number) => {
    const next = new Set(selected);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    setRangeText(formatPageSet(next) || '');
    runner.reset();
  };

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: SplitPayload =
      mode === 'extract'
        ? { fileBuffer: buffer, fileName: file.name, ranges: parsed.ranges }
        : { fileBuffer: buffer, fileName: file.name, ranges: [], groups };
    void runner.run('SPLIT_PDF', payload, [buffer]);
  };

  const outputs = mode === 'extract' ? 1 : groups.length;
  const canRun = total > 0 && !parsed.error && groups.length > 0 && groups.every((g) => g.length > 0);

  return (
    <ToolLayout
      tool={getTool('split')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel={outputs > 1 ? `Split into ${outputs} files` : 'Extract pages'}
      onExecuteAction={execute}
      canExecute={canRun}
      options={
        <>
          <Field label="Mode">
            <div className="grid grid-cols-1 gap-1">
              <Segmented
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  runner.reset();
                }}
                options={[
                  { value: 'extract', label: 'Extract' },
                  { value: 'ranges', label: 'By range' },
                  { value: 'every', label: 'Every N' },
                  { value: 'all', label: 'All pages' },
                ]}
                size="sm"
              />
            </div>
          </Field>
          <p className="text-xs text-muted -mt-2">
            {mode === 'extract' && 'Put the chosen pages into one new PDF.'}
            {mode === 'ranges' && 'Each comma-separated range becomes its own PDF.'}
            {mode === 'every' && 'Cut the document into files of N pages each.'}
            {mode === 'all' && 'One PDF per page.'}
          </p>
          {(mode === 'extract' || mode === 'ranges') && (
            <Field label="Pages" hint={parsed.error ?? 'Example: 1-3, 5, 8- (click thumbnails to toggle)'}>
              <input
                className="input font-mono"
                value={rangeText}
                onChange={(e) => {
                  setRangeText(e.target.value);
                  runner.reset();
                }}
              />
            </Field>
          )}
          {mode === 'every' && (
            <Field label="Pages per file">
              <input
                type="number"
                min={1}
                max={total || 1}
                className="input font-mono w-24"
                value={everyN}
                onChange={(e) => {
                  setEveryN(Math.max(1, Number(e.target.value) || 1));
                  runner.reset();
                }}
              />
            </Field>
          )}
          <p className="font-mono text-2xs text-muted">
            {outputs} output file{outputs === 1 ? '' : 's'}
            {outputs > 1 ? ' · downloaded as a ZIP' : ''}
          </p>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to split" />}
    >
      {parsed.error && (mode === 'extract' || mode === 'ranges') && <Notice tone="warn">{parsed.error}</Notice>}
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-x-4 gap-y-6">
          {pages.map((p, i) => {
            const page = i + 1;
            const g = groupOf.get(i);
            const inOutput = g !== undefined;
            return (
              <PageThumb
                key={i}
                src={p.url}
                aspect={p.width / p.height}
                selected={(mode === 'extract' || mode === 'ranges') && selected.has(page)}
                dimmed={!inOutput}
                onClick={mode === 'extract' || mode === 'ranges' ? () => togglePage(page) : undefined}
                label={
                  <span>
                    {page}
                    {mode !== 'extract' && g !== undefined && <span className="text-accent"> · file {g + 1}</span>}
                  </span>
                }
              />
            );
          })}
        </div>
      )}
    </ToolLayout>
  );
};
