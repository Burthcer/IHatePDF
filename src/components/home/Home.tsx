import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowRight, FileText, Search, X } from 'lucide-react';
import { CATEGORIES, TOOLS, takesPdf } from '../../constants/tools';
import { toolIcon } from '../../constants/toolIcons';
import { Dropzone } from '../common/Dropzone';
import { useFileIngestion, RejectedFilesNotice } from '../../hooks/useFileIngestion';
import { Button, IconButton, Kbd, cn, formatBytes } from '../ui';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import type { PDFFile, ToolMetadata, ToolType } from '../../types/pdf';

interface HomeProps {
  onOpenTool: (id: ToolType, files?: PDFFile[]) => void;
}

function matches(tool: ToolMetadata, q: string): boolean {
  if (!q) return true;
  const hay = `${tool.title} ${tool.description} ${tool.keywords ?? ''}`.toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

function ToolRow({ tool, onClick }: { tool: ToolMetadata; onClick: () => void }) {
  const Icon = toolIcon(tool);
  return (
    <button
      type="button"
      onClick={onClick}
      className="group w-full text-left flex items-start gap-3 px-3 py-2.5 -mx-3 rounded hover:bg-hover focus-visible:bg-hover transition-colors"
    >
      <Icon className="w-[18px] h-[18px] mt-0.5 shrink-0 text-muted group-hover:text-accent transition-colors" strokeWidth={1.75} />
      <span className="min-w-0">
        <span className="block text-sm font-medium leading-snug">{tool.title}</span>
        <span className="block text-xs text-muted leading-snug mt-0.5">{tool.description}</span>
      </span>
    </button>
  );
}

function FileChooser({ files, onPick, onCancel }: { files: PDFFile[]; onPick: (id: ToolType) => void; onCancel: () => void }) {
  const { renderThumbnail } = usePdfRenderer();
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (files[0] && !files[0].encrypted) {
      renderThumbnail(files[0].data, 1, 180)
        .then((url) => !cancelled && setThumb(url))
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [files, renderThumbnail]);

  const pdfTools = TOOLS.filter((t) => takesPdf(t.id));
  const suggested: ToolType[] = files.length > 1 ? ['merge', 'compress', 'organize'] : ['editPdf', 'compress', 'split', 'organize', 'sign', 'pdfToWord'];
  const totalPages = files.reduce((n, f) => n + f.pageCount, 0);

  return (
    <div className="grid md:grid-cols-[200px_minmax(0,1fr)] gap-8">
      <div className="space-y-3">
        <div className="relative w-[180px] bg-white border border-line shadow-page">
          {thumb ? <img src={thumb} alt="" className="w-full block" /> : <div className="aspect-[3/4] flex items-center justify-center text-faint"><FileText className="w-8 h-8" /></div>}
          {files.length > 1 && <span className="absolute -top-2 -right-2 px-1.5 h-5 rounded-full bg-ink text-paper font-mono text-2xs leading-5">{files.length}</span>}
        </div>
        <div className="space-y-0.5">
          {files.slice(0, 4).map((f) => (
            <p key={f.id} className="text-xs font-medium truncate" title={f.name}>
              {f.name}
            </p>
          ))}
          {files.length > 4 && <p className="text-xs text-muted">+ {files.length - 4} more</p>}
          <p className="font-mono text-2xs text-muted">
            {formatBytes(files.reduce((n, f) => n + f.size, 0))} · {totalPages || '?'} pages
          </p>
        </div>
        <Button size="sm" variant="ghost" icon={<X className="w-3.5 h-3.5" />} onClick={onCancel} className="-ml-2">
          Choose different files
        </Button>
      </div>
      <div className="space-y-6">
        <div>
          <p className="label-mono mb-3">Suggested</p>
          <div className="flex flex-wrap gap-2">
            {suggested.map((id) => {
              const t = TOOLS.find((x) => x.id === id)!;
              const Icon = toolIcon(t);
              return (
                <Button key={id} onClick={() => onPick(id)} icon={<Icon className="w-4 h-4" strokeWidth={1.75} />}>
                  {t.title}
                </Button>
              );
            })}
          </div>
        </div>
        <div>
          <p className="label-mono mb-2">Everything else</p>
          <div className="grid sm:grid-cols-2 gap-x-8">
            {pdfTools
              .filter((t) => !suggested.includes(t.id))
              .map((t) => (
                <ToolRow key={t.id} tool={t} onClick={() => onPick(t.id)} />
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

export const Home: React.FC<HomeProps> = ({ onOpenTool }) => {
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<PDFFile[]>([]);
  const [windowDrag, setWindowDrag] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const { ingest, rejected, clearRejected, dialogs } = useFileIngestion();

  const filtered = useMemo(() => TOOLS.filter((t) => matches(t, query)), [query]);

  // Drop PDFs anywhere on the page.
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth++;
      setWindowDrag(true);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) setWindowDrag(false);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const reset = () => {
      depth = 0;
      setWindowDrag(false);
    };
    const drop = async (e: DragEvent) => {
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return;
      e.preventDefault();
      const accepted = await ingest(e.dataTransfer.files);
      if (accepted.length) setFiles(accepted);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over);
    window.addEventListener('drop', reset, true);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('drop', reset, true);
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over);
      window.removeEventListener('drop', drop);
    };
  }, [ingest]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === '/' || (e.key === 'k' && (e.metaKey || e.ctrlKey))) && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const firstMatch = filtered[0];

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6">
      {windowDrag && (
        <div className="fixed inset-0 z-50 pointer-events-none flex items-center justify-center bg-paper/80 border-2 border-dashed border-accent m-2 rounded-md">
          <p className="text-lg font-medium">Drop PDFs to get started</p>
        </div>
      )}

      {files.length > 0 ? (
        <section className="py-10 max-w-5xl">
          <h1 className="text-2xl font-semibold tracking-tight mb-6">What should happen to {files.length === 1 ? 'it' : 'them'}?</h1>
          <FileChooser files={files} onCancel={() => setFiles([])} onPick={(id) => onOpenTool(id, files)} />
        </section>
      ) : (
        <>
          <section className="grid lg:grid-cols-[minmax(0,1fr)_440px] gap-10 items-end pt-12 pb-10 border-b border-line">
            <div>
              <p className="label-mono mb-4">PDF tools that stay on your computer</p>
              <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight leading-[1.05]">
                Get in. Fix the PDF.
                <br />
                Get out.
              </h1>
              <p className="text-muted mt-4 max-w-lg text-[15px] leading-relaxed">
                Edit the actual text in a PDF, merge, split, compress, convert, sign and more. Files are processed inside
                this tab and never leave your machine — it works offline too.
              </p>
            </div>
            <div className="space-y-3">
              <Dropzone
                onFilesAccepted={(f) => setFiles(f)}
                title="Open PDFs"
                subtitle="or drop them anywhere on this page"
                compact
              />
              <RejectedFilesNotice rejected={rejected} onDismiss={clearRejected} />
            </div>
          </section>

          <section className="py-8">
            <div className="flex items-center gap-3 mb-8">
              <div className="relative w-full max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-4 h-4 text-faint" />
                <input
                  ref={searchRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && firstMatch) onOpenTool(firstMatch.id);
                    if (e.key === 'Escape') setQuery('');
                  }}
                  placeholder="Find a tool…"
                  className="input h-9 pl-8 pr-10"
                  aria-label="Find a tool"
                />
                {query ? (
                  <IconButton label="Clear search" size="sm" className="absolute right-1 top-1/2 -translate-y-1/2" onClick={() => setQuery('')}>
                    <X className="w-3.5 h-3.5" />
                  </IconButton>
                ) : (
                  <span className="absolute right-2 top-1/2 -translate-y-1/2">
                    <Kbd>/</Kbd>
                  </span>
                )}
              </div>
              {query && firstMatch && (
                <span className="hidden sm:inline-flex items-center gap-1 text-xs text-muted">
                  <Kbd>Enter</Kbd> opens {firstMatch.title} <ArrowRight className="w-3 h-3" />
                </span>
              )}
            </div>

            {filtered.length === 0 ? (
              <p className="text-sm text-muted py-10">Nothing matches “{query}”.</p>
            ) : (
              <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-12 gap-y-10">
                {CATEGORIES.map((cat) => {
                  const tools = filtered.filter((t) => t.category === cat.id);
                  if (!tools.length) return null;
                  return (
                    <div key={cat.id} className={cn(cat.id === 'edit' && !query && 'lg:row-span-1')}>
                      <h2 className="label-mono pb-2 mb-1 border-b border-line flex justify-between">
                        <span>{cat.label}</span>
                        <span>{tools.length}</span>
                      </h2>
                      <div className="pt-1">
                        {tools.map((t) => (
                          <ToolRow key={t.id} tool={t} onClick={() => onOpenTool(t.id)} />
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
      {dialogs}
    </div>
  );
};
