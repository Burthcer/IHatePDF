import React, { useMemo, useRef, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { nativeFirst } from '../../services/nativeWorker';
import { splitNative } from '../pageTools.native';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PageThumb } from '../../components/common/PageThumb';
import { VirtualGrid } from '../../components/common/VirtualGrid';
import { Button, Field, IconButton, Notice, Segmented, Spinner, cn } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { formatPageSet, parsePageRanges, rangesToPages, type PageRange } from '../../services/pageRanges';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, SplitPayload } from '../../types/worker';

type Mode = 'parts' | 'every' | 'all';

/** One output file in "Choose pages" mode: its own page ranges and (optionally) its own file name. */
interface Part {
  id: number;
  text: string;
  name: string;
  /** Filled in by the app (not typed): keeps starting right after the part before it when that part changes. */
  follows: boolean;
}

/** Highest page (1-based) a ranges text covers, or 0. */
const lastPage = (text: string, total: number) => {
  try {
    return Math.max(0, ...rangesToPages(parsePageRanges(text, total)));
  } catch {
    return 0;
  }
};
/** The pages after `last`: "6-12", "12", or "" when none are left. */
const pagesAfter = (last: number, total: number) => (last >= total ? '' : last + 1 === total ? String(total) : `${last + 1}-${total}`);
/** Parts the app filled in start right after the part before them (part 1 = 1-5 → part 2 = 6-…). */
const reflow = (ps: Part[], total: number) => {
  const out = [...ps];
  for (let i = 1; i < out.length; i++) if (out[i].follows) out[i] = { ...out[i], text: pagesAfter(lastPage(out[i - 1].text, total), total) };
  return out;
};

/** One colour per output file, on its card and around its pages (readable on light and dark). */
const PART_COLORS = ['#2563eb', '#ea580c', '#16a34a', '#9333ea', '#db2777', '#0891b2', '#ca8a04', '#dc2626'];
const partColor = (i: number) => PART_COLORS[i % PART_COLORS.length];

/** Same default names as the engines (split.worker.ts, pages.rs): base_01_p1-3.pdf, or base_p1-3.pdf for one file. */
const pageLabel = (g: number[]) => (g.length ? (g[0] === g[g.length - 1] ? `p${g[0] + 1}` : `p${g[0] + 1}-${g[g.length - 1] + 1}`) : '');
/** What a user typed as a file name, made safe for Windows/Android file names and zip entries ('' = use the default). */
const cleanFileName = (s: string) =>
  s
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
    .replace(/\.pdf$/i, '')
    .trim()
    .replace(/[. ]+$/, '');

interface SplitViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const SplitView: React.FC<SplitViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [mode, setMode] = useState<Mode>('parts');
  const nextId = useRef(2);
  const [parts, setParts] = useState<Part[]>([{ id: 1, text: '1', name: '', follows: false }]);
  const [active, setActive] = useState(1);
  const [everyN, setEveryN] = useState(2);
  const file = files[0];
  const base = (file?.name ?? 'document').replace(/\.[^/.]+$/, '');
  const { pages, thumbRef } = usePageThumbnails(file?.data);
  const total = pages.length || file?.pageCount || 0;
  const runner = useToolRunner<ProcessedPdfResult>(
    nativeFirst(() => new Worker(new URL('./split.worker.ts', import.meta.url), { type: 'module' }), { SPLIT_PDF: splitNative })
  );

  const parsed = useMemo(
    () =>
      parts.map((part, i) => {
        if (!total) return { ranges: [] as PageRange[], error: null as string | null };
        if (part.follows && !part.text.trim()) return { ranges: [] as PageRange[], error: `No pages left after part ${i}: change part ${i} or remove this part.` };
        try {
          return { ranges: parsePageRanges(part.text, total), error: null };
        } catch (e) {
          return { ranges: [] as PageRange[], error: (e as Error).message };
        }
      }),
    [parts, total]
  );
  const partsError = parsed.find((p) => p.error)?.error ?? null;
  const choosing = mode === 'parts';

  const groups: number[][] = useMemo(() => {
    if (!total) return [];
    if (mode === 'all') return Array.from({ length: total }, (_, i) => [i]);
    if (mode === 'every') {
      const n = Math.max(1, everyN);
      const out: number[][] = [];
      for (let i = 0; i < total; i += n) out.push(Array.from({ length: Math.min(n, total - i) }, (_, k) => i + k));
      return out;
    }
    return parsed.map((p) => rangesToPages(p.ranges).map((n) => n - 1));
  }, [mode, everyN, parsed, total]);

  /** The file name each part gets: the typed one, else the default; duplicates get " (2)", " (3)"… */
  const defaultName = (i: number) => {
    const g = groups[i] ?? [];
    return groups.length === 1 ? `${base}_${pageLabel(g)}` : `${base}_${String(i + 1).padStart(String(groups.length).length, '0')}_${pageLabel(g)}`;
  };
  const fileNames = useMemo(() => {
    if (!choosing) return [];
    const seen = new Map<string, number>();
    return parts.map((part, i) => {
      const stem = cleanFileName(part.name) || defaultName(i);
      const n = (seen.get(stem.toLowerCase()) ?? 0) + 1;
      seen.set(stem.toLowerCase(), n);
      return `${n > 1 ? `${stem} (${n})` : stem}.pdf`;
    });
    // defaultName reads groups/base, both listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [choosing, parts, groups, base]);

  const activeIndex = Math.max(0, parts.findIndex((p) => p.id === active));
  const activePages = useMemo(() => new Set(rangesToPages(parsed[activeIndex]?.ranges ?? [])), [parsed, activeIndex]);
  /** 0-based page → the output files (0-based) it goes into. */
  const filesOf = useMemo(() => {
    const m = new Map<number, number[]>();
    groups.forEach((g, gi) =>
      g.forEach((p) => {
        const at = m.get(p) ?? [];
        if (!at.includes(gi)) m.set(p, [...at, gi]);
      })
    );
    return m;
  }, [groups]);

  /** Per part: its pages that other parts also take, and which parts (shown as a warning on the card). */
  const overlaps = useMemo(
    () =>
      groups.map((g, gi) => {
        const shared = g.filter((p) => (filesOf.get(p)?.length ?? 0) > 1);
        const others = [...new Set(shared.flatMap((p) => filesOf.get(p)!.filter((x) => x !== gi)))].sort((a, b) => a - b);
        return { pages: formatPageSet(shared.map((p) => p + 1)), count: new Set(shared).size, others };
      }),
    [groups, filesOf]
  );
  const leftOut = useMemo(() => (choosing && total ? formatPageSet(Array.from({ length: total }, (_, i) => i).filter((p) => !filesOf.has(p)).map((p) => p + 1)) : ''), [choosing, total, filesOf]);

  const edit = (id: number, change: Partial<Part>) => {
    // Typing (or tapping pages) makes a part the user's own; parts after it that the app filled in follow along.
    const own = change.text !== undefined ? { follows: false } : {};
    setParts((ps) => reflow(ps.map((p) => (p.id === id ? { ...p, ...change, ...own } : p)), total));
    runner.reset();
  };

  const addPart = () => {
    // Start the new part right after the last one, so "Add part" walks through the document.
    const id = nextId.current++;
    setParts((ps) => reflow([...ps, { id, text: '', name: '', follows: true }], total));
    setActive(id);
    runner.reset();
  };

  const removePart = (id: number) => {
    const next = reflow(
      parts.filter((p) => p.id !== id),
      total
    );
    setParts(next);
    if (id === active) setActive(next[next.length - 1].id);
    runner.reset();
  };

  const togglePage = (page: number) => {
    const next = new Set(activePages);
    if (next.has(page)) next.delete(page);
    else next.add(page);
    edit(parts[activeIndex].id, { text: formatPageSet(next) });
  };

  const execute = () => {
    const payload: SplitPayload = { fileBuffer: file.data, fileName: file.name, ranges: [], groups, ...(choosing && { names: fileNames }) };
    void runner.run('SPLIT_PDF', payload);
  };

  const outputs = groups.length;
  const canRun = total > 0 && (!choosing || !partsError) && outputs > 0 && groups.every((g) => g.length > 0);

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
            <Segmented
              value={mode}
              onChange={(m) => {
                setMode(m);
                runner.reset();
              }}
              options={[
                { value: 'parts', label: 'Choose pages' },
                { value: 'every', label: 'Every N' },
                { value: 'all', label: 'One per page' },
              ]}
              size="sm"
            />
          </Field>
          <p className="text-xs text-muted -mt-2">
            {mode === 'parts' && 'Each part becomes its own PDF. Type its pages (1-3, 5, 8-), or tap pages to add them to the selected part.'}
            {mode === 'every' && 'Cut the document into files of N pages each.'}
            {mode === 'all' && 'One PDF per page.'}
          </p>
          {choosing && (
            <div className="space-y-2">
              {parts.map((part, i) => {
                const err = parsed[i]?.error;
                const count = groups[i]?.length ?? 0;
                const color = partColor(i);
                const selected = part.id === active;
                return (
                  <div
                    key={part.id}
                    onClick={() => setActive(part.id)}
                    className={cn('rounded-md border border-l-4 p-2 space-y-1.5', selected ? 'bg-hover' : 'border-line')}
                    style={{ borderLeftColor: color, ...(selected && { borderColor: color }) }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} aria-hidden />
                      <label htmlFor={`split-part-${part.id}`} className="text-xs font-medium w-12 shrink-0">
                        Part {i + 1}
                      </label>
                      <input
                        id={`split-part-${part.id}`}
                        aria-label={`Pages for part ${i + 1}`}
                        className="input font-mono flex-1 min-w-0"
                        placeholder="1-3, 5"
                        value={part.text}
                        onFocus={() => setActive(part.id)}
                        onChange={(e) => edit(part.id, { text: e.target.value })}
                      />
                      {parts.length > 1 && (
                        <IconButton label={`Remove part ${i + 1}`} size="sm" onClick={() => removePart(part.id)}>
                          <X className="w-4 h-4" />
                        </IconButton>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 pl-5">
                      <input
                        aria-label={`File name for part ${i + 1}`}
                        className="input flex-1 min-w-0 text-sm"
                        placeholder={defaultName(i)}
                        value={part.name}
                        maxLength={120}
                        onFocus={() => setActive(part.id)}
                        onChange={(e) => edit(part.id, { name: e.target.value })}
                      />
                      <span className="font-mono text-2xs text-muted">.pdf</span>
                    </div>
                    <p className={cn('text-2xs pl-5', err ? 'text-danger' : 'font-mono text-muted')}>
                      {err ?? `${count} page${count === 1 ? '' : 's'} → ${fileNames[i] ?? ''}`}
                    </p>
                    {!err && overlaps[i]?.count > 0 && (
                      <p className="text-2xs pl-5 text-warn">
                        {overlaps[i].count === 1 ? 'Page' : 'Pages'} {overlaps[i].pages} {overlaps[i].count === 1 ? 'is' : 'are'} also in part{' '}
                        {overlaps[i].others.map((o) => o + 1).join(', ')} (in both files)
                      </p>
                    )}
                  </div>
                );
              })}
              <Button size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={addPart} disabled={!total}>
                Add part
              </Button>
              {leftOut && <p className="text-2xs text-muted">Not in any part (left out): {leftOut}</p>}
            </div>
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
            {outputs > 1 ? ' · saved as a ZIP' : ''}
          </p>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to split" />}
    >
      {partsError && choosing && <Notice tone="warn">{partsError}</Notice>}
      {pages.length === 0 ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <VirtualGrid count={pages.length} minColWidth={132} rowHeight={196}>
          {(i) => {
            const p = pages[i];
            const page = i + 1;
            const fs = filesOf.get(i);
            const color = fs ? partColor(fs[0]) : undefined;
            const shared = (fs?.length ?? 0) > 1;
            return (
              <PageThumb
                key={i}
                src={p.url}
                viewRef={thumbRef(i)}
                aspect={p.width / p.height}
                ring={fs && (outputs > 1 || choosing) ? fs.slice(0, 2).map(partColor) : undefined}
                selected={choosing && activePages.has(page)}
                dimmed={!fs}
                onClick={choosing ? () => togglePage(page) : undefined}
                label={
                  <span>
                    {page}
                    {fs && outputs > 1 && (
                      <span className={cn('font-medium', shared && 'text-warn')} style={shared ? undefined : { color }} title={shared ? 'This page goes into more than one file' : undefined}>
                        {' '}
                        · {choosing ? 'part' : 'file'}
                        {shared ? 's' : ''} {fs.map((f) => f + 1).join(', ')}
                      </span>
                    )}
                  </span>
                }
              />
            );
          }}
        </VirtualGrid>
      )}
    </ToolLayout>
  );
};
