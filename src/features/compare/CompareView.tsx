import React, { useMemo, useState } from 'react';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolHeader } from '../../components/layout/ToolLayout';
import { Button, Notice, Panel, ProgressLine, Segmented, cn } from '../../components/ui';
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

async function extractWords(buffer: ArrayBuffer): Promise<{ words: Word[]; pages: number }> {
  const doc = await openPdfJsDocument(buffer).promise;
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

async function renderPages(buffer: ArrayBuffer): Promise<HTMLCanvasElement[]> {
  const doc = await openPdfJsDocument(buffer).promise;
  const out: HTMLCanvasElement[] = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
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
      out.push(c);
      page.cleanup();
    }
    return out;
  } finally {
    await memoryManager.destroyPdfDocument(doc);
  }
}

function overlay(a: HTMLCanvasElement, b: HTMLCanvasElement): { url: string; changed: number } {
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
    return ctx.getImageData(0, 0, w, h).data;
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
  return { url: out.toDataURL('image/jpeg', 0.85), changed: changed / (w * h) };
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
  const [visual, setVisual] = useState<VisualPage[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!a || !b) return;
    setError(null);
    setOps(null);
    setVisual(null);
    setTooDifferent(false);
    try {
      setBusy({ progress: 5, stage: 'Reading text of both documents…' });
      const [ta, tb] = await Promise.all([extractWords(a.rawBuffer), extractWords(b.rawBuffer)]);
      setBusy({ progress: 30, stage: 'Comparing words…' });
      await new Promise((r) => setTimeout(r, 0));
      const d = diffWords(ta.words, tb.words);
      if (d) setOps(d);
      else setTooDifferent(true);

      setBusy({ progress: 45, stage: 'Rendering pages…' });
      const [ca, cb] = await Promise.all([renderPages(a.rawBuffer), renderPages(b.rawBuffer)]);
      const n = Math.max(ca.length, cb.length);
      const pages: VisualPage[] = [];
      for (let i = 0; i < n; i++) {
        setBusy({ progress: 50 + (i / n) * 50, stage: `Comparing page ${i + 1} of ${n}…` });
        const pa = ca[i];
        const pb = cb[i];
        if (pa && pb) {
          const o = overlay(pa, pb);
          pages.push({ page: i + 1, a: pa.toDataURL('image/jpeg', 0.8), b: pb.toDataURL('image/jpeg', 0.8), diff: o.url, changed: o.changed });
        } else {
          pages.push({ page: i + 1, a: pa ? pa.toDataURL('image/jpeg', 0.8) : null, b: pb ? pb.toDataURL('image/jpeg', 0.8) : null, diff: null, changed: 1 });
        }
        await new Promise((r) => setTimeout(r, 0));
      }
      [...ca, ...cb].forEach((c) => (c.width = 0));
      setVisual(pages);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
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
        <Pick label="Original" file={a} onFile={(f) => { setA(f); setOps(null); setVisual(null); }} />
        <Pick label="Changed version" file={b} onFile={(f) => { setB(f); setOps(null); setVisual(null); }} />
        <div className="flex gap-2">
          <Button variant="primary" size="lg" disabled={!a || !b || !!busy} loading={!!busy} onClick={() => void run()}>
            Compare
          </Button>
          {(a || b) && (
            <Button size="lg" variant="ghost" onClick={() => { setA(null); setB(null); setOps(null); setVisual(null); }}>
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

      {(ops || visual || tooDifferent) && (
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

          {mode === 'visual' && visual && (
            <div className="space-y-8">
              <p className="text-xs text-muted">
                <span className="text-danger font-medium">Red</span> is only in the original, <span className="text-ok font-medium">green</span> only in the changed version.
              </p>
              {visual.map((p) => (
                <div key={p.page} className="space-y-2">
                  <p className="label-mono">
                    Page {p.page} · {p.diff ? (p.changed < 0.0005 ? 'no visible change' : `${(p.changed * 100).toFixed(1)}% of pixels differ`) : p.a ? 'only in the original' : 'only in the changed version'}
                  </p>
                  <div className="grid md:grid-cols-3 gap-3">
                    {[p.a, p.diff, p.b].map((src, k) => (
                      <div key={k} className="bg-white shadow-page min-h-[120px]">
                        {src && <img src={src} alt="" className="w-full block" />}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
