import React, { useCallback, useEffect, useRef, useState } from 'react';
import '@fontsource/caveat/600.css';
import { Copy, Eraser, X } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { Button, Field, IconButton, Notice, Segmented, Spinner, cn } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, SignaturePlacement, StampSignaturePayload } from '../../types/worker';

interface SignViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

interface Signature {
  url: string;
  bytes: ArrayBuffer;
  aspect: number; // width / height
}

const PAGE_W = 540;
const INK = ['#111111', '#1f3a93', '#0b6e4f'];

/** Crops a canvas to its non-transparent pixels (plus padding) and returns PNG. */
async function trimToPng(canvas: HTMLCanvasElement): Promise<Signature | null> {
  const ctx = canvas.getContext('2d')!;
  const { data, width, height } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const pad = 6;
  minX = Math.max(0, minX - pad);
  minY = Math.max(0, minY - pad);
  maxX = Math.min(width - 1, maxX + pad);
  maxY = Math.min(height - 1, maxY + pad);
  const out = document.createElement('canvas');
  out.width = maxX - minX + 1;
  out.height = maxY - minY + 1;
  out.getContext('2d')!.drawImage(canvas, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
  const blob = await new Promise<Blob | null>((r) => out.toBlob(r, 'image/png'));
  if (!blob) return null;
  return { url: URL.createObjectURL(blob), bytes: await blob.arrayBuffer(), aspect: out.width / out.height };
}

function DrawPad({ ink, onChange }: { ink: string; onChange: (sig: Signature | null) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const last = useRef<{ x: number; y: number } | null>(null);
  const mid = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const c = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    c.width = 480 * dpr;
    c.height = 170 * dpr;
    c.getContext('2d')!.scale(dpr, dpr);
  }, []);

  const pt = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  return (
    <div className="space-y-2">
      <div className="relative">
        <canvas
          ref={ref}
          className="w-full h-[170px] bg-white border border-line-strong rounded touch-none cursor-crosshair"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            last.current = pt(e);
            mid.current = last.current;
          }}
          onPointerMove={(e) => {
            if (!last.current) return;
            const ctx = ref.current!.getContext('2d')!;
            const p = pt(e);
            const m = { x: (last.current.x + p.x) / 2, y: (last.current.y + p.y) / 2 };
            ctx.strokeStyle = ink;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.lineWidth = e.pressure && e.pointerType === 'pen' ? 1 + e.pressure * 3 : 2.4;
            ctx.beginPath();
            ctx.moveTo(mid.current!.x, mid.current!.y);
            ctx.quadraticCurveTo(last.current.x, last.current.y, m.x, m.y);
            ctx.stroke();
            last.current = p;
            mid.current = m;
          }}
          onPointerUp={() => {
            last.current = null;
            void trimToPng(ref.current!).then(onChange);
          }}
        />
        <div className="absolute left-6 right-6 bottom-9 border-b border-dashed border-line-strong pointer-events-none" />
      </div>
      <Button
        size="sm"
        variant="ghost"
        icon={<Eraser className="w-3.5 h-3.5" />}
        onClick={() => {
          const c = ref.current!;
          c.getContext('2d')!.clearRect(0, 0, c.width, c.height);
          onChange(null);
        }}
      >
        Clear
      </Button>
    </div>
  );
}

async function typedSignature(text: string, ink: string): Promise<Signature | null> {
  if (!text.trim()) return null;
  await document.fonts.load('600 96px Caveat');
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = '600 96px Caveat, cursive';
  const w = Math.ceil(ctx.measureText(text).width) + 40;
  c.width = w;
  c.height = 150;
  ctx.font = '600 96px Caveat, cursive';
  ctx.fillStyle = ink;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 20, 75);
  return trimToPng(c);
}

export const SignView: React.FC<SignViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [ink, setInk] = useState(INK[0]);
  const [typed, setTyped] = useState('');
  const [signature, setSignature] = useState<Signature | null>(null);
  const [placements, setPlacements] = useState<SignaturePlacement[]>([]);
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const drag = useRef<{ index: number; kind: 'move' | 'resize'; sx: number; sy: number; orig: SignaturePlacement } | null>(null);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer, 40);
  const { renderThumbnail } = usePdfRenderer();
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./sign.worker.ts', import.meta.url), { type: 'module' }));
  const page = pages[pageIndex];
  const scale = page ? PAGE_W / page.width : 1;

  useEffect(() => {
    if (pages.length && pageIndex === 0) setPageIndex(pages.length - 1); // signatures usually go last
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages.length]);

  useEffect(() => {
    if (!file || !page) return;
    let cancelled = false;
    setPreview(null);
    renderThumbnail(file.rawBuffer, pageIndex + 1, PAGE_W * Math.min(2, window.devicePixelRatio || 1))
      .then((u) => !cancelled && setPreview(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file, page, pageIndex, renderThumbnail]);

  useEffect(() => {
    if (mode !== 'type') return;
    let cancelled = false;
    void typedSignature(typed, ink).then((s) => !cancelled && setSignature(s));
    return () => {
      cancelled = true;
    };
  }, [mode, typed, ink]);

  const changed = useCallback(() => runner.reset(), [runner]);

  const place = (e: React.MouseEvent) => {
    if (!signature || !page || drag.current) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const width = 160;
    const height = width / signature.aspect;
    const x = Math.min(page.width - width, Math.max(0, (e.clientX - r.left) / scale - width / 2));
    const y = Math.min(page.height - height, Math.max(0, (e.clientY - r.top) / scale - height / 2));
    setPlacements((p) => [...p, { pageIndex, x, y, width, height }]);
    changed();
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.sx) / scale;
    const dy = (e.clientY - d.sy) / scale;
    setPlacements((all) =>
      all.map((p, i) => {
        if (i !== d.index) return p;
        if (d.kind === 'move') return { ...p, x: d.orig.x + dx, y: d.orig.y + dy };
        const width = Math.max(30, d.orig.width + dx);
        return { ...p, width, height: width * (d.orig.height / d.orig.width) };
      })
    );
  };

  const execute = () => {
    if (!signature) return;
    const buffer = file.rawBuffer.slice(0);
    const sig = signature.bytes.slice(0);
    const payload: StampSignaturePayload = { fileBuffer: buffer, fileName: file.name, signatureImageBytes: sig, placements };
    void runner.run('STAMP_SIGNATURE', payload, [buffer, sig]);
  };

  const onThisPage = placements.map((p, i) => ({ p, i })).filter(({ p }) => p.pageIndex === pageIndex);

  return (
    <ToolLayout
      tool={getTool('sign')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel={placements.length ? `Sign (${placements.length} placement${placements.length === 1 ? '' : 's'})` : 'Place your signature first'}
      onExecuteAction={execute}
      canExecute={!!signature && placements.length > 0}
      options={
        <>
          <Segmented
            value={mode}
            onChange={(m) => {
              setMode(m);
              setSignature(null);
            }}
            options={[
              { value: 'draw', label: 'Draw' },
              { value: 'type', label: 'Type' },
              { value: 'upload', label: 'Image' },
            ]}
          />
          {mode !== 'upload' && (
            <Field label="Ink">
              <div className="flex gap-2">
                {INK.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`Ink ${c}`}
                    onClick={() => setInk(c)}
                    className={cn('w-6 h-6 rounded-full border-2', ink === c ? 'border-accent' : 'border-transparent')}
                    style={{ backgroundColor: c }}
                  />
                ))}
              </div>
            </Field>
          )}
          {mode === 'draw' && <DrawPad key={ink} ink={ink} onChange={setSignature} />}
          {mode === 'type' && (
            <Field label="Your name">
              <input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Jane Appleseed" />
            </Field>
          )}
          {mode === 'upload' && (
            <GenericFileInput
              accept="image/png,image/jpeg,image/webp"
              compact
              title="Choose a signature image"
              subtitle="PNG with a transparent background looks best"
              onFileAccepted={async (f) => {
                const img = new Image();
                img.src = URL.createObjectURL(f);
                await img.decode();
                const c = document.createElement('canvas');
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                c.getContext('2d')!.drawImage(img, 0, 0);
                setSignature(await trimToPng(c));
              }}
            />
          )}
          {signature && (
            <div className="p-2 bg-white border border-line rounded flex items-center justify-center h-16">
              <img src={signature.url} alt="Signature" className="max-h-full max-w-full" />
            </div>
          )}
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to sign" />}
    >
      {!page ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3">
          {!signature ? (
            <Notice>Create a signature in the panel, then click on the page where it should go.</Notice>
          ) : (
            <p className="text-xs text-muted">Click the page to place the signature. Drag to move, drag the corner to resize.</p>
          )}
          <div
            className={cn('relative bg-white shadow-page select-none', signature && 'cursor-copy')}
            style={{ width: PAGE_W, height: page.height * scale }}
            onClick={place}
            onPointerMove={onMove}
            onPointerUp={() => {
              if (drag.current) changed();
              window.setTimeout(() => (drag.current = null), 0);
            }}
          >
            {preview && <img src={preview} alt="" className="absolute inset-0 w-full h-full" draggable={false} />}
            {signature &&
              onThisPage.map(({ p, i }) => (
                <div
                  key={i}
                  className="absolute outline outline-1 outline-accent/70 hover:outline-accent cursor-move group"
                  style={{ left: p.x * scale, top: p.y * scale, width: p.width * scale, height: p.height * scale }}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                    drag.current = { index: i, kind: 'move', sx: e.clientX, sy: e.clientY, orig: p };
                  }}
                >
                  <img src={signature.url} alt="" className="w-full h-full" draggable={false} />
                  <IconButton
                    label="Remove"
                    size="sm"
                    className="absolute -top-3.5 -right-3.5 w-6 h-6 bg-panel border-line opacity-0 group-hover:opacity-100"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => {
                      setPlacements((all) => all.filter((_, k) => k !== i));
                      changed();
                    }}
                  >
                    <X className="w-3 h-3" />
                  </IconButton>
                  <div
                    className="absolute -right-1 -bottom-1 w-2.5 h-2.5 bg-panel border border-accent cursor-nwse-resize"
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      (e.currentTarget.parentElement!.parentElement as HTMLElement).setPointerCapture(e.pointerId);
                      drag.current = { index: i, kind: 'resize', sx: e.clientX, sy: e.clientY, orig: p };
                    }}
                  />
                </div>
              ))}
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
            {onThisPage.length > 0 && pages.length > 1 && (
              <Button
                size="sm"
                icon={<Copy className="w-3.5 h-3.5" />}
                onClick={() => {
                  const src = onThisPage[onThisPage.length - 1].p;
                  setPlacements((all) => [...all.filter((p) => p.pageIndex === pageIndex), ...pages.map((_, k) => ({ ...src, pageIndex: k })).filter((p) => p.pageIndex !== pageIndex)]);
                  changed();
                }}
              >
                Same spot on every page
              </Button>
            )}
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
