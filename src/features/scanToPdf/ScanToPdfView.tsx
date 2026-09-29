import React, { useEffect, useRef, useState } from 'react';
import { Camera, Check, ImagePlus, RotateCw, X } from 'lucide-react';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { Button, Field, IconButton, Modal, Notice, Panel, Segmented, cn } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { memoryManager } from '../../services/memoryManager';
import { getTool } from '../../constants/tools';
import { applyFilter, warpQuad, type Point, type ScanFilter } from './scanImage';
import type { PDFFile } from '../../types/pdf';
import type { ImagesToPdfPayload, ProcessedPdfResult } from '../../types/worker';

interface ScanToPdfViewProps {
  onBack: () => void;
}

interface Shot {
  id: string;
  source: ImageBitmap;
  quad: Point[];
  rotation: number;
  filter: ScanFilter;
  url: string;
  bytes: ArrayBuffer;
}

const MAX_SIDE = 2400;

async function renderShot(shot: Omit<Shot, 'url' | 'bytes'>): Promise<{ url: string; bytes: ArrayBuffer }> {
  let canvas = warpQuad(shot.source, shot.quad);
  if (shot.rotation % 360) {
    const r = document.createElement('canvas');
    const turned = shot.rotation % 180 !== 0;
    r.width = turned ? canvas.height : canvas.width;
    r.height = turned ? canvas.width : canvas.height;
    const ctx = r.getContext('2d')!;
    ctx.translate(r.width / 2, r.height / 2);
    ctx.rotate((shot.rotation * Math.PI) / 180);
    ctx.drawImage(canvas, -canvas.width / 2, -canvas.height / 2);
    canvas = r;
  }
  applyFilter(canvas, shot.filter);
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/jpeg', shot.filter === 'document' ? 0.8 : 0.88));
  if (!blob) throw new Error('Could not encode the page.');
  return { url: memoryManager.registerUrl(URL.createObjectURL(blob)), bytes: await blob.arrayBuffer() };
}

async function bitmapFrom(source: CanvasImageSource | Blob): Promise<ImageBitmap> {
  const bmp = source instanceof Blob ? await createImageBitmap(source, { imageOrientation: 'from-image' }) : await createImageBitmap(source);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  if (scale === 1) return bmp;
  const out = await createImageBitmap(bmp, { resizeWidth: Math.round(bmp.width * scale), resizeHeight: Math.round(bmp.height * scale), resizeQuality: 'high' });
  bmp.close();
  return out;
}

function fullQuad(w: number, h: number): Point[] {
  return [
    { x: 0, y: 0 },
    { x: w, y: 0 },
    { x: w, y: h },
    { x: 0, y: h },
  ];
}

function CornerEditor({ shot, onDone, onCancel }: { shot: Shot; onDone: (quad: Point[], filter: ScanFilter, rotation: number) => void; onCancel: () => void }) {
  const [quad, setQuad] = useState(shot.quad);
  const [filter, setFilter] = useState(shot.filter);
  const [rotation, setRotation] = useState(shot.rotation);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragging = useRef<number | null>(null);
  const W = 560;
  const scale = W / shot.source.width;
  const H = shot.source.height * scale;

  useEffect(() => {
    const c = canvasRef.current!;
    c.width = W;
    c.height = H;
    c.getContext('2d')!.drawImage(shot.source, 0, 0, W, H);
  }, [shot.source, H]);

  const move = (e: React.PointerEvent) => {
    if (dragging.current === null) return;
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const x = Math.max(0, Math.min(shot.source.width, (e.clientX - r.left) / scale));
    const y = Math.max(0, Math.min(shot.source.height, (e.clientY - r.top) / scale));
    setQuad((q) => q.map((p, i) => (i === dragging.current ? { x, y } : p)));
  };

  return (
    <Modal
      open
      onClose={onCancel}
      title="Adjust page"
      width={620}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Check className="w-4 h-4" />} onClick={() => onDone(quad, filter, rotation)}>
            Apply
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted mb-3">Drag the corners onto the edges of the paper — the page is straightened automatically.</p>
      <div className="relative mx-auto select-none touch-none" style={{ width: W, height: H }} onPointerMove={move} onPointerUp={() => (dragging.current = null)}>
        <canvas ref={canvasRef} className="block" style={{ width: W, height: H }} />
        <svg className="absolute inset-0 pointer-events-none" width={W} height={H}>
          <polygon points={quad.map((p) => `${p.x * scale},${p.y * scale}`).join(' ')} fill="rgb(222 58 36 / 0.12)" stroke="rgb(222 58 36)" strokeWidth={1.5} />
        </svg>
        {quad.map((p, i) => (
          <div
            key={i}
            onPointerDown={(e) => {
              (e.currentTarget.parentElement as HTMLElement).setPointerCapture(e.pointerId);
              dragging.current = i;
            }}
            className="absolute w-5 h-5 -ml-2.5 -mt-2.5 rounded-full bg-panel border-2 border-accent cursor-move"
            style={{ left: p.x * scale, top: p.y * scale }}
          />
        ))}
      </div>
      <div className="flex items-end gap-3 mt-4">
        <Field label="Look" className="flex-1">
          <Segmented value={filter} onChange={setFilter} size="sm" options={[{ value: 'original', label: 'Color' }, { value: 'gray', label: 'Grayscale' }, { value: 'document', label: 'Document' }]} />
        </Field>
        <Button size="sm" icon={<RotateCw className="w-3.5 h-3.5" />} onClick={() => setRotation((r) => (r + 90) % 360)}>
          Rotate
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setQuad(fullQuad(shot.source.width, shot.source.height))}>
          Whole image
        </Button>
      </div>
    </Modal>
  );
}

export const ScanToPdfView: React.FC<ScanToPdfViewProps> = ({ onBack }) => {
  const [shots, setShots] = useState<Shot[]>([]);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [defaultFilter, setDefaultFilter] = useState<ScanFilter>('document');
  const videoRef = useRef<HTMLVideoElement>(null);
  const photoRef = useRef<HTMLInputElement>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('../imageToPdf/imagesToPdf.worker.ts', import.meta.url), { type: 'module' }));

  useEffect(() => () => stream?.getTracks().forEach((t) => t.stop()), [stream]);

  const startCamera = async () => {
    setCameraError(null);
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('This browser can’t open the camera here (it needs HTTPS). Use “Add photos” instead.');
      return;
    }
    try {
      setStream(await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 3840 }, height: { ideal: 2160 } } }));
    } catch (err) {
      setCameraError(err instanceof Error ? `Camera unavailable: ${err.message}` : 'Camera unavailable.');
    }
  };

  const addShot = async (source: ImageBitmap) => {
    const base = { id: crypto.randomUUID(), source, quad: fullQuad(source.width, source.height), rotation: 0, filter: defaultFilter };
    const rendered = await renderShot(base);
    setShots((s) => [...s, { ...base, ...rendered }]);
    runner.reset();
    return base.id;
  };

  const capture = async () => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return;
    await addShot(await bitmapFrom(v));
  };

  const execute = () => {
    const images = shots.map((s) => ({ bytes: s.bytes.slice(0), type: 'jpg' as const }));
    const payload: ImagesToPdfPayload = { images, orientation: 'auto', margin: 'none', pageSize: 'a4', fileName: 'scan' };
    void runner.run('IMAGES_TO_PDF', payload, images.map((i) => i.bytes));
  };

  const editingShot = shots.find((s) => s.id === editing);
  const pseudo: PDFFile[] = shots.map((s, i) => ({ id: s.id, name: `Page ${i + 1}`, size: s.bytes.byteLength, pageCount: 1, data: new Blob([s.bytes]), previewUrls: [s.url] }));

  const cameraPanel = (
    <Panel className="p-4 space-y-3">
      <div className="relative bg-ink/95 rounded aspect-[4/3] overflow-hidden flex items-center justify-center">
        {stream ? <video ref={(el) => { videoRef.current = el; if (el && el.srcObject !== stream) el.srcObject = stream; }} autoPlay playsInline muted className="w-full h-full object-contain" /> : <Camera className="w-10 h-10 text-muted" />}
      </div>
      {cameraError && <Notice tone="warn">{cameraError}</Notice>}
      <div className="flex flex-wrap gap-2">
        {stream ? (
          <>
            <Button variant="primary" icon={<Camera className="w-4 h-4" />} onClick={() => void capture()}>
              Capture page
            </Button>
            <Button onClick={() => { stream.getTracks().forEach((t) => t.stop()); setStream(null); }}>Stop camera</Button>
          </>
        ) : (
          <Button variant="primary" icon={<Camera className="w-4 h-4" />} onClick={() => void startCamera()}>
            Start camera
          </Button>
        )}
        <Button icon={<ImagePlus className="w-4 h-4" />} onClick={() => photoRef.current?.click()}>
          Add photos
        </Button>
        <input
          ref={photoRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          className="hidden"
          onChange={async (e) => {
            const list = Array.from(e.target.files ?? []);
            e.target.value = '';
            for (const f of list) await addShot(await bitmapFrom(f));
          }}
        />
      </div>
    </Panel>
  );

  return (
    <ToolLayout
      tool={getTool('scanToPdf')}
      files={pseudo}
      hideFileList
      onBack={onBack}
      onClearFiles={() => setShots([])}
      onRemoveFile={(id) => setShots((s) => s.filter((x) => x.id !== id))}
      {...runner.layout}
      actionButtonLabel={`Make PDF (${shots.length} page${shots.length === 1 ? '' : 's'})`}
      onExecuteAction={execute}
      canExecute={shots.length > 0}
      options={
        <Field label="Default look for new pages">
          <Segmented value={defaultFilter} onChange={setDefaultFilter} size="sm" options={[{ value: 'original', label: 'Color' }, { value: 'gray', label: 'Gray' }, { value: 'document', label: 'Document' }]} />
        </Field>
      }
      emptyState={cameraPanel}
    >
      {cameraPanel}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-4">
        {shots.map((s, i) => (
          <div key={s.id} className="group relative bg-panel border border-line rounded p-2">
            <button type="button" className="block w-full aspect-[3/4] bg-sunken overflow-hidden" onClick={() => setEditing(s.id)} title="Adjust corners and look">
              <img src={s.url} alt="" className="w-full h-full object-contain" />
            </button>
            <div className="flex items-center justify-between mt-1.5">
              <span className="font-mono text-2xs text-muted">{i + 1}</span>
              <button className="text-2xs text-muted hover:text-ink" onClick={() => setEditing(s.id)}>
                Adjust
              </button>
            </div>
            <IconButton label="Remove" size="sm" className={cn('absolute top-1 right-1 bg-panel border-line opacity-0 group-hover:opacity-100')} onClick={() => setShots((all) => all.filter((x) => x.id !== s.id))}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          </div>
        ))}
      </div>
      {editingShot && (
        <CornerEditor
          shot={editingShot}
          onCancel={() => setEditing(null)}
          onDone={async (quad, filter, rotation) => {
            setEditing(null);
            const rendered = await renderShot({ ...editingShot, quad, filter, rotation });
            setShots((all) => all.map((x) => (x.id === editingShot.id ? { ...x, quad, filter, rotation, ...rendered } : x)));
            runner.reset();
          }}
        />
      )}
    </ToolLayout>
  );
};
