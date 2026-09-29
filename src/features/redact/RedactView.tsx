import React, { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Button, IconButton, Notice, Section, Spinner, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import type { AskAnswer } from '../../hooks/useWorkerBridge';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { openPdfJsDocument, pdfjsLib } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, RedactionBox, RedactPdfPayload } from '../../types/worker';

interface RedactViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

const PAGE_W = 560;
const RENDER_SCALE = 2.5; // ≈180 dpi for flattened pages

const PRESETS: Array<{ id: string; label: string; re: RegExp }> = [
  { id: 'email', label: 'Email addresses', re: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi },
  { id: 'phone', label: 'Phone numbers', re: /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?/g },
  { id: 'number', label: 'Long numbers (IDs, accounts, cards)', re: /\b\d(?:[\d\s-]{6,}\d)\b/g },
];

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function findMatches(data: Blob, patterns: RegExp[]): Promise<RedactionBox[]> {
  const doc = await openPdfJsDocument(data).promise;
  const boxes: RedactionBox[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items as TextItem[]) {
        if (!item.str) continue;
        const m = pdfjsLib.Util.transform(vp.transform, item.transform);
        const h = Math.hypot(m[2], m[3]) || item.height;
        const horizontal = Math.abs(m[1]) < 1e-3 && Math.abs(m[2]) < 1e-3;
        const width = item.width * (horizontal ? Math.abs(vp.transform[0] || vp.transform[1]) || 1 : 1);
        for (const re of patterns) {
          re.lastIndex = 0;
          let match: RegExpExecArray | null;
          while ((match = re.exec(item.str))) {
            if (!match[0]) {
              re.lastIndex++;
              continue;
            }
            const len = item.str.length;
            if (horizontal) {
              const x0 = m[4] + (width * match.index) / len;
              const w = (width * match[0].length) / len;
              boxes.push({ pageIndex: p - 1, x: x0 - 1, y: m[5] - h * 0.9 - 1, width: w + 2, height: h * 1.2 + 2 });
            } else {
              // rotated text: cover the whole run
              const xs = [m[4], m[4] + m[0] * (width / h), m[4] + m[2], m[4] + m[0] * (width / h) + m[2]];
              const ys = [m[5], m[5] + m[1] * (width / h), m[5] - m[3], m[5] + m[1] * (width / h) - m[3]];
              boxes.push({ pageIndex: p - 1, x: Math.min(...xs) - 2, y: Math.min(...ys) - 2, width: Math.max(...xs) - Math.min(...xs) + 4, height: Math.max(...ys) - Math.min(...ys) + 4 });
            }
          }
        }
      }
      page.cleanup();
    }
  } finally {
    await memoryManager.destroyPdfDocument(doc);
  }
  return boxes;
}

export const RedactView: React.FC<RedactViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [boxes, setBoxes] = useState<RedactionBox[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [matchCase, setMatchCase] = useState(false);
  const [presets, setPresets] = useState<Set<string>>(new Set());
  const [searching, setSearching] = useState(false);
  const [lastFound, setLastFound] = useState<number | null>(null);
  const [stripMeta, setStripMeta] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const [prepError, setPrepError] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.data, 40, 0); // sizes only
  const { renderThumbnail } = usePdfRenderer();
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./redact.worker.ts', import.meta.url), { type: 'module' }), {
    onAsk: (what, data) => renderRedacted(what, data),
  });
  const page = pages[pageIndex];
  const scale = page ? PAGE_W / page.width : 1;

  useEffect(() => {
    if (!file || !page) return;
    let cancelled = false;
    setPreview(null);
    renderThumbnail(file.data, pageIndex + 1, PAGE_W * Math.min(2, window.devicePixelRatio || 1))
      .then((u) => !cancelled && setPreview(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file, page, pageIndex, renderThumbnail]);

  const toPt = (e: React.PointerEvent) => {
    const r = pageRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale };
  };

  const search = async () => {
    const patterns: RegExp[] = [];
    if (query.trim()) patterns.push(new RegExp(escapeRe(query.trim()), matchCase ? 'g' : 'gi'));
    PRESETS.filter((p) => presets.has(p.id)).forEach((p) => patterns.push(new RegExp(p.re.source, p.re.flags)));
    if (!patterns.length) return;
    setSearching(true);
    try {
      const found = await findMatches(file.data, patterns);
      setBoxes((b) => [...b, ...found]);
      setLastFound(found.length);
      runner.reset();
    } finally {
      setSearching(false);
    }
  };

  // The worker asks for each redacted page only when it writes it (one render at a time).
  const renderDoc = useRef<PDFDocumentProxy | null>(null);
  const boxesRef = useRef(boxes);
  boxesRef.current = boxes;

  const renderRedacted = async (what: string, data: unknown): Promise<AskAnswer> => {
    const doc = renderDoc.current;
    if (what !== 'redacted-page' || !doc) throw new Error('Nothing to render.');
    const idx = (data as { pageIndex: number }).pageIndex;
    const pg = await doc.getPage(idx + 1);
    const vp = pg.getViewport({ scale: RENDER_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(vp.width);
    canvas.height = Math.ceil(vp.height);
    const ctx = canvas.getContext('2d', { alpha: false })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await pg.render({ canvasContext: ctx, viewport: vp, canvas }).promise;
    // The boxes are burned into the pixels: nothing underneath survives.
    ctx.fillStyle = '#000';
    boxesRef.current.filter((b) => b.pageIndex === idx).forEach((b) => ctx.fillRect(b.x * RENDER_SCALE, b.y * RENDER_SCALE, b.width * RENDER_SCALE, b.height * RENDER_SCALE));
    const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
    const size = { width: canvas.width, height: canvas.height };
    canvas.width = 0;
    canvas.height = 0;
    pg.cleanup();
    if (!blob) throw new Error('Could not render a page.');
    const jpeg = await blob.arrayBuffer();
    return { result: { jpeg, ...size }, transfer: [jpeg] };
  };

  const execute = async () => {
    setPreparing(true);
    setPrepError(null);
    try {
      const doc = await openPdfJsDocument(file.data).promise;
      renderDoc.current = doc;
      const indices = [...new Set(boxes.map((b) => b.pageIndex))].sort((a, b) => a - b);
      const pagesOut: RedactPdfPayload['pages'] = [];
      for (const idx of indices) {
        const base = (await doc.getPage(idx + 1)).getViewport({ scale: 1 });
        pagesOut.push({ pageIndex: idx, widthPt: base.width, heightPt: base.height });
      }
      setPreparing(false);
      const payload: RedactPdfPayload = { fileBuffer: file.data, fileName: file.name, pages: pagesOut, stripMetadata: stripMeta };
      await runner.run('REDACT_PDF', payload);
    } catch (err) {
      setPrepError(err instanceof Error ? err.message : String(err));
    } finally {
      setPreparing(false);
      const doc = renderDoc.current;
      renderDoc.current = null;
      if (doc) await memoryManager.destroyPdfDocument(doc);
    }
  };

  const pageBoxes = boxes.map((b, i) => ({ b, i })).filter(({ b }) => b.pageIndex === pageIndex);
  const pagesWithBoxes = new Set(boxes.map((b) => b.pageIndex)).size;

  return (
    <ToolLayout
      tool={getTool('redact')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      isProcessing={runner.layout.isProcessing || preparing}
      stage={preparing ? 'Rendering redacted pages…' : runner.layout.stage}
      error={prepError ?? runner.layout.error}
      resultNote={runner.result?.note}
      actionButtonLabel={boxes.length ? `Redact ${boxes.length} area${boxes.length === 1 ? '' : 's'}` : 'Mark areas to redact'}
      onExecuteAction={() => void execute()}
      canExecute={boxes.length > 0}
      options={
        <>
          <Section title="Find and redact">
            <div className="flex gap-2">
              <input className="input" placeholder="Word or phrase" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && void search()} />
              <IconButton label="Search" className="border-line-strong" onClick={() => void search()} disabled={searching}>
                {searching ? <Spinner className="w-3.5 h-3.5" /> : <Search className="w-4 h-4" />}
              </IconButton>
            </div>
            <Toggle checked={matchCase} onChange={setMatchCase} label="Match case" />
            <div className="space-y-1.5 pt-1">
              {PRESETS.map((p) => (
                <Toggle
                  key={p.id}
                  checked={presets.has(p.id)}
                  onChange={(v) =>
                    setPresets((s) => {
                      const n = new Set(s);
                      if (v) n.add(p.id);
                      else n.delete(p.id);
                      return n;
                    })
                  }
                  label={p.label}
                />
              ))}
            </div>
            <Button size="sm" onClick={() => void search()} loading={searching} disabled={!query.trim() && !presets.size}>
              Mark all matches
            </Button>
            {lastFound !== null && <p className="text-2xs text-muted">{lastFound ? `${lastFound} match${lastFound === 1 ? '' : 'es'} marked.` : 'No matches.'}</p>}
          </Section>
          <Section title="Output">
            <Toggle checked={stripMeta} onChange={setStripMeta} label="Remove document metadata" hint="Title, author and XMP data can leak what you redacted." />
            {boxes.length > 0 && (
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted">
                  {boxes.length} areas on {pagesWithBoxes} page{pagesWithBoxes === 1 ? '' : 's'}
                </span>
                <button className="text-muted hover:text-danger" onClick={() => setBoxes([])}>
                  Clear all
                </button>
              </div>
            )}
          </Section>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to redact" />}
    >
      <Notice>
        Drag across anything you want gone. Pages you redact are flattened to images, so nothing underneath can be copied or
        recovered; other pages stay as they are.
      </Notice>
      {!page ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          <div
            ref={pageRef}
            className="relative bg-white shadow-page select-none cursor-crosshair"
            style={{ width: PAGE_W, height: page.height * scale }}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              const p = toPt(e);
              setDraft({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            }}
            onPointerMove={(e) => draft && setDraft({ ...draft, ...(({ x, y }) => ({ x1: x, y1: y }))(toPt(e)) })}
            onPointerUp={() => {
              if (draft && Math.abs(draft.x1 - draft.x0) > 2 && Math.abs(draft.y1 - draft.y0) > 2) {
                setBoxes((b) => [
                  ...b,
                  { pageIndex, x: Math.min(draft.x0, draft.x1), y: Math.min(draft.y0, draft.y1), width: Math.abs(draft.x1 - draft.x0), height: Math.abs(draft.y1 - draft.y0) },
                ]);
                runner.reset();
              }
              setDraft(null);
            }}
          >
            {preview && <img src={preview} alt="" className="absolute inset-0 w-full h-full pointer-events-none" draggable={false} />}
            {pageBoxes.map(({ b, i }) => (
              <div key={i} className="group absolute bg-black/85" style={{ left: b.x * scale, top: b.y * scale, width: b.width * scale, height: b.height * scale }}>
                <button
                  aria-label="Remove this redaction"
                  className="absolute -top-2 -right-2 w-4 h-4 rounded-full bg-panel border border-line-strong text-ink items-center justify-center hidden group-hover:flex"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => {
                    setBoxes((all) => all.filter((_, k) => k !== i));
                    runner.reset();
                  }}
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
            {draft && (
              <div
                className="absolute bg-black/60 border border-accent"
                style={{ left: Math.min(draft.x0, draft.x1) * scale, top: Math.min(draft.y0, draft.y1) * scale, width: Math.abs(draft.x1 - draft.x0) * scale, height: Math.abs(draft.y1 - draft.y0) * scale }}
              />
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-muted">
            <Button size="sm" variant="ghost" disabled={pageIndex === 0} onClick={() => setPageIndex((i) => i - 1)}>
              Previous
            </Button>
            <span className="font-mono text-2xs">
              Page {pageIndex + 1} / {pages.length}
            </span>
            <Button size="sm" variant="ghost" disabled={pageIndex >= pages.length - 1} onClick={() => setPageIndex((i) => i + 1)}>
              Next
            </Button>
          </div>
          {pagesWithBoxes > 0 && (
            <div className="flex flex-wrap gap-1.5 justify-center">
              {[...new Set(boxes.map((b) => b.pageIndex))].sort((a, b) => a - b).map((i) => (
                <button key={i} onClick={() => setPageIndex(i)} className={`font-mono text-2xs px-1.5 h-5 rounded border ${i === pageIndex ? 'border-ink' : 'border-line hover:border-line-strong'}`}>
                  p{i + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </ToolLayout>
  );
};
