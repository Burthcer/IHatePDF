import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolHeader } from '../../components/layout/ToolLayout';
import { Button, Notice, Panel, ProgressLine, Segmented, Spinner, cn } from '../../components/ui';
import { openPdfJsDocument } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { getTool } from '../../constants/tools';
import { diffWords, type DiffOp, type Word } from './textDiff';
import type { PDFFile } from '../../types/pdf';

interface CompareViewProps {
  onBack: () => void;
}

interface VisualPage {
  page: number;
  a: string | null;
  b: string | null;
  diff: string | null;
  changed: number; // fraction of pixels
}

const RENDER_W = 900;
const CONTEXT = 10;
/** Rendered page comparisons kept around (the rest are redrawn if scrolled back to). */
const VISUAL_KEEP = 24;

async function extractWords(data: Blob): Promise<{ words: Word[]; pages: number }> {
  const doc = await openPdfJsDocument(data).promise;
  const words: Word[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const text = (content.items as TextItem[]).map((i) => (i.str ?? '') + (i.hasEOL ? ' ' : '')).join(' ');
      text.split(/\s+/).filter(Boolean).forEach((w) => words.push({ text: w, page: p }));
      page.cleanup();
    }
    return { words, pages: doc.numPages };
  } finally {
    await memoryManager.destroyPdfDocument(doc);
  }
}

async function renderPage(doc: PDFDocumentProxy, p: number): Promise<HTMLCanvasElement | null> {
  if (p > doc.numPages) return null;
  const page = await doc.getPage(p);
  const base = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: RENDER_W / base.width });
  const c = document.createElement('canvas');
  c.width = Math.ceil(vp.width);
  c.height = Math.ceil(vp.height);
  const ctx = c.getContext('2d', { alpha: false, willReadFrequently: true })!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp, canvas: c }).promise;
  page.cleanup();
  return c;
}

/** A canvas as a JPEG object URL (kept by the browser, not in page memory). */
async function toUrl(c: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/jpeg', 0.8));
  if (!blob) throw new Error('Could not render a page.');
  return URL.createObjectURL(blob);
}

async function comparePage(a: PDFDocumentProxy, b: PDFDocumentProxy, index: number): Promise<VisualPage> {
  const [pa, pb] = await Promise.all([renderPage(a, index + 1), renderPage(b, index + 1)]);
  try {
    let diff: string | null = null;
    let changed = 1;
    if (pa && pb) {
      const o = overlay(pa, pb);
      diff = await toUrl(o.canvas);
      o.canvas.width = 0;
      changed = o.changed;
    }
    return { page: index + 1, a: pa ? await toUrl(pa) : null, b: pb ? await toUrl(pb) : null, diff, changed };
  } finally {
    if (pa) pa.width = 0;
    if (pb) pb.width = 0;
  }
}

const revokePage = (p: VisualPage) => [p.a, p.b, p.diff].forEach((u) => u && URL.revokeObjectURL(u));

function overlay(a: HTMLCanvasElement, b: HTMLCanvasElement): { canvas: HTMLCanvasElement; changed: number } {
  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  const read = (c: HTMLCanvasElement) => {
    const t = document.createElement('canvas');
    t.width = w;
    t.height = h;
    const ctx = t.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(c, 0, 0);
    const data = ctx.getImageData(0, 0, w, h).data;
    t.width = 0;
    return data;
  };
  const da = read(a);
  const db = read(b);
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(w, h);
  let changed = 0;
  for (let i = 0; i < da.length; i += 4) {
    const ga = (da[i] + da[i + 1] + da[i + 2]) / 3;
    const gb = (db[i] + db[i + 1] + db[i + 2]) / 3;
    const diff = Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
    if (diff > 90) {
      changed++;
      // only in A (removed): red; only in B (added): green
      if (ga < gb) img.data.set([214, 52, 31, 255], i);
      else img.data.set([30, 140, 80, 255], i);
    } else {
      const v = 255 - (255 - Math.min(ga, gb)) * 0.18;
      img.data.set([v, v, v, 255], i);
    }
  }
  octx.putImageData(img, 0, 0);
  return { canvas: out, changed: changed / (w * h) };
}

function Pick({ label, file, onFile }: { label: string; file: PDFFile | null; onFile: (f: PDFFile) => void }) {
  return (
    <div className="space-y-2">
      <p className="label-mono">{label}</p>
      {file ? (
        <Panel className="p-3 flex items-center justify-between gap-2">
          <span className="text-sm truncate" title={file.name}>
            {file.name}
          </span>
          <span className="font-mono text-2xs text-muted shrink-0">{file.pageCount} pg</span>
        </Panel>
      ) : (
        <Dropzone multiple={false} compact onFilesAccepted={(f) => f[0] && onFile(f[0])} title={`Choose the ${label.toLowerCase()}`} />
      )}
    </div>
  );
}

export const CompareView: React.FC<CompareViewProps> = ({ onBack }) => {
  const [a, setA] = useState<PDFFile | null>(null);
  const [b, setB] = useState<PDFFile | null>(null);
  const [mode, setMode] = useState<'text' | 'visual'>('text');
  const [busy, setBusy] = useState<{ progress: number; stage: string } | null>(null);
  const [ops, setOps] = useState<DiffOp[] | null>(null);
  const [tooDifferent, setTooDifferent] = useState(false);
  // Visual overlay: only the pages scrolled to are rendered, one at a time,
  // and only the most recent few are kept.
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [visual, setVisual] = useState<Map<number, VisualPage>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const docs = useRef<Promise<[PDFDocumentProxy, PDFDocumentProxy]> | null>(null);
  const cache = useRef(new Map<number, VisualPage>());
  const pending = useRef<number[]>([]);
  const working = useRef(false);
  const visible = useRef(new Set<number>());
  const generation = useRef(0);

  const closeVisual = useCallback(() => {
    generation.current++;
    pending.current = [];
    cache.current.forEach(revokePage);
    cache.current = new Map();
    setVisual(new Map());
    const open = docs.current;
    docs.current = null;
    void open?.then(([da, db]) => Promise.all([memoryManager.destroyPdfDocument(da), memoryManager.destroyPdfDocument(db)])).catch(() => undefined);
  }, []);

  useEffect(() => closeVisual, [closeVisual]);

  const files = useRef({ a, b });
  files.current = { a, b };

  // Stable (the observer below holds on to it); reads the current files from a ref.
  const pumpVisual = useCallback(async (): Promise<void> => {
    const { a, b } = files.current;
    if (working.current || !a || !b) return;
    working.current = true;
    const gen = generation.current;
    try {
      while (pending.current.length && gen === generation.current) {
        const i = pending.current.shift()!;
        if (cache.current.has(i)) continue;
        docs.current ??= Promise.all([openPdfJsDocument(a.data).promise, openPdfJsDocument(b.data).promise]);
        const [da, db] = await docs.current;
        const page = await comparePage(da, db, i);
        if (gen !== generation.current) {
          revokePage(page);
          break;
        }
        cache.current.set(i, page);
        // Forget pages that are far off screen.
        for (const k of [...cache.current.keys()]) {
          if (cache.current.size <= VISUAL_KEEP) break;
          if (!visible.current.has(k)) {
            revokePage(cache.current.get(k)!);
            cache.current.delete(k);
          }
        }
        setVisual(new Map(cache.current));
      }
    } catch (err) {
      if (gen === generation.current) setError(err instanceof Error ? err.message : String(err));
    } finally {
      working.current = false;
      // Requests queued for a newer comparison while this one was finishing.
      if (gen !== generation.current && pending.current.length) void pumpVisual();
    }
  }, []);

  const observer = useRef<IntersectionObserver | null>(null);
  const rowRef = useCallback(
    (el: HTMLDivElement | null) => {
      if (!el) return;
      observer.current ??= new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            const i = Number((e.target as HTMLElement).dataset.index);
            if (e.isIntersecting) {
              visible.current.add(i);
              if (!cache.current.has(i) && !pending.current.includes(i)) pending.current.push(i);
            } else {
              visible.current.delete(i);
              pending.current = pending.current.filter((k) => k !== i);
            }
          }
          void pumpVisual();
        },
        { rootMargin: '600px 0px' }
      );
      observer.current.observe(el);
    },
    [pumpVisual]
  );
  useEffect(() => () => observer.current?.disconnect(), []);

  const run = async () => {
    if (!a || !b) return;
    setError(null);
    setOps(null);
    closeVisual();
    setPageCount(null);
    setTooDifferent(false);
    try {
      setBusy({ progress: 5, stage: 'Reading text of both documents…' });
      const [ta, tb] = await Promise.all([extractWords(a.data), extractWords(b.data)]);
      setBusy({ progress: 70, stage: 'Comparing words…' });
      await new Promise((r) => setTimeout(r, 0));
      const d = diffWords(ta.words, tb.words);
      if (d) setOps(d);
      else setTooDifferent(true);
      setPageCount(Math.max(ta.pages, tb.pages));
      // Rows already on screen from a previous comparison won't report again.
      pending.current = [...visible.current];
      void pumpVisual();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const clear = () => {
    setOps(null);
    setPageCount(null);
    closeVisual();
  };

  const stats = useMemo(() => {
    if (!ops) return null;
    let ins = 0;
    let del = 0;
    let changes = 0;
    ops.forEach((o) => {
      if (o.type === 'ins') ins += o.words.length;
      if (o.type === 'del') del += o.words.length;
      if (o.type !== 'eq') changes++;
    });
    return { ins, del, changes };
  }, [ops]);

  return (
    <div className="max-w-[1400px] mx-auto px-4 sm:px-6 py-8 space-y-6">
      <ToolHeader tool={getTool('compare')} onBack={onBack} />
      <div className="grid md:grid-cols-[1fr_1fr_auto] gap-4 items-end">
        <Pick label="Original" file={a} onFile={(f) => { setA(f); clear(); }} />
        <Pick label="Changed version" file={b} onFile={(f) => { setB(f); clear(); }} />
        <div className="flex gap-2">
          <Button variant="primary" size="lg" disabled={!a || !b || !!busy} loading={!!busy} onClick={() => void run()}>
            Compare
          </Button>
          {(a || b) && (
            <Button size="lg" variant="ghost" onClick={() => { setA(null); setB(null); clear(); }}>
              Reset
            </Button>
          )}
        </div>
      </div>

      {busy && (
        <div className="max-w-md">
          <ProgressLine progress={busy.progress} stage={busy.stage} />
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}

      {(ops || pageCount || tooDifferent) && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-4">
            <Segmented value={mode} onChange={setMode} options={[{ value: 'text', label: 'Text changes' }, { value: 'visual', label: 'Visual overlay' }]} />
            {stats && mode === 'text' && (
              <p className="font-mono text-2xs text-muted">
                {stats.changes} change{stats.changes === 1 ? '' : 's'} · <span className="text-ok">+{stats.ins} words</span> · <span className="text-danger">−{stats.del} words</span>
              </p>
            )}
          </div>

          {mode === 'text' && (
            <>
              {tooDifferent && <Notice tone="warn">These documents differ too much for a word-by-word comparison — use the visual overlay.</Notice>}
              {ops && stats?.changes === 0 && <Notice tone="ok">The text of both documents is identical.</Notice>}
              {ops && stats && stats.changes > 0 && (
                <Panel className="p-6 text-sm leading-7 max-h-[70vh] overflow-y-auto scroll-thin">
                  {ops.map((op, i) => {
                    if (op.type === 'eq') {
                      const words = op.words;
                      const head = i === 0 ? [] : words.slice(0, CONTEXT);
                      const tail = i === ops.length - 1 ? [] : words.slice(-CONTEXT);
                      if (words.length <= CONTEXT * 2 + 4) return <span key={i}>{words.map((w) => w.text).join(' ')} </span>;
                      return (
                        <span key={i}>
                          {head.map((w) => w.text).join(' ')}
                          {head.length > 0 && ' '}
                          <span className="inline-block mx-1 px-1.5 font-mono text-2xs text-faint border border-line rounded-sm align-middle">
                            … p{tail[0]?.page ?? words[words.length - 1].page}
                          </span>{' '}
                          {tail.map((w) => w.text).join(' ')}{' '}
                        </span>
                      );
                    }
                    return (
                      <span
                        key={i}
                        className={cn(op.type === 'ins' ? 'bg-[#e3f4e9] text-[#14683d] dark:bg-[#123524] dark:text-[#8fe0b0]' : 'bg-[#fbe4df] text-[#a4281a] line-through dark:bg-[#3d1712] dark:text-[#ff9f8f]', 'px-0.5 rounded-sm')}
                        title={`${op.type === 'ins' ? 'Added' : 'Removed'} on page ${op.words[0].page}`}
                      >
                        {op.words.map((w) => w.text).join(' ')}
                      </span>
                    );
                  }).reduce<React.ReactNode[]>((acc, node, i) => (i ? [...acc, ' ', node] : [node]), [])}
                </Panel>
              )}
            </>
          )}

          {mode === 'visual' && pageCount && (
            <div className="space-y-8">
              <p className="text-xs text-muted">
                <span className="text-danger font-medium">Red</span> is only in the original, <span className="text-ok font-medium">green</span> only in the changed version.
              </p>
              {Array.from({ length: pageCount }, (_, i) => {
                const p = visual.get(i);
                return (
                  <div key={i} ref={rowRef} data-index={i} className="space-y-2">
                    <p className="label-mono">
                      Page {i + 1}
                      {p && <> · {p.diff ? (p.changed < 0.0005 ? 'no visible change' : `${(p.changed * 100).toFixed(1)}% of pixels differ`) : p.a ? 'only in the original' : 'only in the changed version'}</>}
                    </p>
                    <div className="grid md:grid-cols-3 gap-3">
                      {[p?.a, p?.diff, p?.b].map((src, k) => (
                        <div key={k} className="bg-white shadow-page min-h-[240px] flex items-center justify-center">
                          {src ? <img src={src} alt="" className="w-full block" /> : !p && <Spinner className="w-4 h-4 text-faint" />}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
