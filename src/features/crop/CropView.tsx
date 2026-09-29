import React, { useEffect, useRef, useState } from 'react';
import { ScanSearch } from 'lucide-react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Button, Field, Segmented, Spinner } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { formatPageSet, parsePageRanges, rangesToPages } from '../../services/pageRanges';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { CropMarginsMm, CropPayload, ProcessedPdfResult } from '../../types/worker';

const PT_PER_MM = 72 / 25.4;
const PREVIEW_W = 460;

interface CropViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

type Side = keyof CropMarginsMm;

export const CropView: React.FC<CropViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [margins, setMargins] = useState<CropMarginsMm>({ top: 10, right: 10, bottom: 10, left: 10 });
  const [scope, setScope] = useState<'all' | 'range'>('all');
  const [rangeText, setRangeText] = useState('1');
  const [pageIndex, setPageIndex] = useState(0);
  const [preview, setPreview] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const drag = useRef<{ side: Side; startX: number; startY: number; start: number } | null>(null);
  const file = files[0];
  const { pages } = usePageThumbnails(file?.data, 60, 0); // sizes only
  const { renderThumbnail } = usePdfRenderer();
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./crop.worker.ts', import.meta.url), { type: 'module' }));

  const page = pages[pageIndex];
  const scale = page ? PREVIEW_W / page.width : 1; // px per pt
  const mmToPx = PT_PER_MM * scale;

  useEffect(() => {
    if (!file || !page) return;
    let cancelled = false;
    renderThumbnail(file.data, pageIndex + 1, PREVIEW_W * Math.min(2, window.devicePixelRatio || 1))
      .then((url) => !cancelled && setPreview(url))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file, pageIndex, page, renderThumbnail]);

  const setMargin = (side: Side, mm: number) => {
    if (!page) return;
    const maxW = page.width / PT_PER_MM;
    const maxH = page.height / PT_PER_MM;
    setMargins((m) => {
      const next = { ...m, [side]: Math.max(0, Math.round(mm * 10) / 10) };
      if (next.left + next.right > maxW - 5) next[side] = m[side];
      if (next.top + next.bottom > maxH - 5) next[side] = m[side];
      return next;
    });
    runner.reset();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dxMm = (e.clientX - d.startX) / mmToPx;
    const dyMm = (e.clientY - d.startY) / mmToPx;
    const delta = d.side === 'left' ? dxMm : d.side === 'right' ? -dxMm : d.side === 'top' ? dyMm : -dyMm;
    setMargin(d.side, d.start + delta);
  };

  const detect = async () => {
    if (!file || !page) return;
    setDetecting(true);
    try {
      const url = await renderThumbnail(file.data, pageIndex + 1, 400);
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(img, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      let minX = width, minY = height, maxX = -1, maxY = -1;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const k = (y * width + x) * 4;
          if (data[k] < 235 || data[k + 1] < 235 || data[k + 2] < 235) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) return;
      const pxToMm = page.width / width / PT_PER_MM;
      const pad = 3; // mm of breathing room
      setMargins({
        left: Math.max(0, Math.round((minX * pxToMm - pad) * 10) / 10),
        top: Math.max(0, Math.round((minY * pxToMm - pad) * 10) / 10),
        right: Math.max(0, Math.round(((width - 1 - maxX) * pxToMm - pad) * 10) / 10),
        bottom: Math.max(0, Math.round(((height - 1 - maxY) * pxToMm - pad) * 10) / 10),
      });
      runner.reset();
    } finally {
      setDetecting(false);
    }
  };

  let rangeError: string | null = null;
  let indices: number[] | undefined;
  if (scope === 'range' && pages.length) {
    try {
      indices = rangesToPages(parsePageRanges(rangeText, pages.length)).map((p) => p - 1);
    } catch (e) {
      rangeError = (e as Error).message;
    }
  }

  const execute = () => {
    const payload: CropPayload = { fileBuffer: file.data, fileName: file.name, margins, pageIndices: indices };
    void runner.run('CROP_PAGES', payload);
  };

  const handle = (side: Side) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { side, startX: e.clientX, startY: e.clientY, start: margins[side] };
  };

  const W = PREVIEW_W;
  const H = page ? page.height * scale : 0;
  const box = { left: margins.left * mmToPx, top: margins.top * mmToPx, right: W - margins.right * mmToPx, bottom: H - margins.bottom * mmToPx };

  return (
    <ToolLayout
      tool={getTool('crop')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Crop"
      onExecuteAction={execute}
      canExecute={!rangeError && Object.values(margins).some((v) => v > 0)}
      options={
        <>
          <div className="grid grid-cols-2 gap-3">
            {(['top', 'bottom', 'left', 'right'] as Side[]).map((side) => (
              <Field key={side} label={side[0].toUpperCase() + side.slice(1)} aside="mm">
                <input type="number" min={0} step={0.5} className="input font-mono" value={margins[side]} onChange={(e) => setMargin(side, Number(e.target.value) || 0)} />
              </Field>
            ))}
          </div>
          <Button size="sm" icon={<ScanSearch className="w-3.5 h-3.5" />} loading={detecting} onClick={detect}>
            Detect margins from this page
          </Button>
          <Field label="Apply to">
            <Segmented value={scope} onChange={setScope} size="sm" options={[{ value: 'all', label: 'All pages' }, { value: 'range', label: 'Some pages' }]} />
          </Field>
          {scope === 'range' && (
            <Field label="Pages" hint={rangeError ?? 'Example: 1-3, 5'}>
              <input className="input font-mono" value={rangeText} onChange={(e) => setRangeText(e.target.value)} />
            </Field>
          )}
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to crop" />}
    >
      {!page ? (
        <div className="flex items-center gap-2 text-sm text-muted py-10 justify-center">
          <Spinner /> Loading pages…
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 py-2">
          <div className="relative bg-white shadow-page select-none" style={{ width: W, height: H }} onPointerMove={onPointerMove} onPointerUp={() => (drag.current = null)}>
            {preview && <img src={preview} alt="" className="absolute inset-0 w-full h-full" draggable={false} />}
            {/* shade what gets cut away */}
            <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(20,18,14,0.45)', clipPath: `polygon(0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${box.left}px ${box.top}px, ${box.left}px ${box.bottom}px, ${box.right}px ${box.bottom}px, ${box.right}px ${box.top}px, ${box.left}px ${box.top}px)` }} />
            <div className="absolute border border-accent pointer-events-none" style={{ left: box.left, top: box.top, width: box.right - box.left, height: box.bottom - box.top }} />
            <div onPointerDown={handle('top')} className="absolute h-3 -mt-1.5 cursor-ns-resize" style={{ left: box.left, width: box.right - box.left, top: box.top }} />
            <div onPointerDown={handle('bottom')} className="absolute h-3 -mt-1.5 cursor-ns-resize" style={{ left: box.left, width: box.right - box.left, top: box.bottom }} />
            <div onPointerDown={handle('left')} className="absolute w-3 -ml-1.5 cursor-ew-resize" style={{ top: box.top, height: box.bottom - box.top, left: box.left }} />
            <div onPointerDown={handle('right')} className="absolute w-3 -ml-1.5 cursor-ew-resize" style={{ top: box.top, height: box.bottom - box.top, left: box.right }} />
            {(['top', 'bottom', 'left', 'right'] as Side[]).map((side) => {
              const x = side === 'left' ? box.left : side === 'right' ? box.right : (box.left + box.right) / 2;
              const y = side === 'top' ? box.top : side === 'bottom' ? box.bottom : (box.top + box.bottom) / 2;
              return <div key={side} onPointerDown={handle(side)} className="absolute w-2.5 h-2.5 -ml-[5px] -mt-[5px] bg-panel border border-accent" style={{ left: x, top: y, cursor: side === 'left' || side === 'right' ? 'ew-resize' : 'ns-resize' }} />;
            })}
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
          {scope === 'range' && indices && <p className="text-2xs text-muted">Cropping pages {formatPageSet(indices.map((i) => i + 1))}</p>}
        </div>
      )}
    </ToolLayout>
  );
};
