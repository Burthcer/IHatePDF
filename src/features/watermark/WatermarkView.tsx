import React, { useEffect, useMemo, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PositionGrid } from '../../components/common/PositionGrid';
import { GenericFileInput } from '../../components/common/GenericFileInput';
import { Button, ColorInput, Field, Segmented, Slider, Toggle } from '../../components/ui';
import { useToolRunner } from '../../hooks/useToolRunner';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { usePageThumbnails } from '../../hooks/usePageThumbnails';
import { memoryManager } from '../../services/memoryManager';
import { getTool } from '../../constants/tools';
import type { PDFFile } from '../../types/pdf';
import type { ProcessedPdfResult, WatermarkPayload, WatermarkPosition } from '../../types/worker';

interface WatermarkViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

const PREVIEW_W = 420;

async function toPngOrJpeg(file: File): Promise<{ bytes: ArrayBuffer; type: 'png' | 'jpg'; url: string }> {
  const url = memoryManager.registerUrl(URL.createObjectURL(file));
  if (file.type === 'image/png' || file.type === 'image/jpeg') return { bytes: await file.arrayBuffer(), type: file.type === 'image/png' ? 'png' : 'jpg', url };
  const img = new Image();
  img.src = url;
  await img.decode();
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  c.getContext('2d')!.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Unsupported image.');
  return { bytes: await blob.arrayBuffer(), type: 'png', url };
}

export const WatermarkView: React.FC<WatermarkViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles.slice(0, 1));
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [image, setImage] = useState<{ bytes: ArrayBuffer; type: 'png' | 'jpg'; url: string } | null>(null);
  const [fontSize, setFontSize] = useState(56);
  const [family, setFamily] = useState<'sans' | 'serif' | 'mono'>('sans');
  const [color, setColor] = useState('#C0392B');
  const [opacity, setOpacity] = useState(0.25);
  const [rotation, setRotation] = useState(45);
  const [position, setPosition] = useState<WatermarkPosition>('center');
  const [tile, setTile] = useState(false);
  const [layer, setLayer] = useState<'above' | 'below'>('above');
  const [imageScale, setImageScale] = useState(0.4);
  const [pagesText, setPagesText] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  const runner = useToolRunner<ProcessedPdfResult>(() => new Worker(new URL('./watermark.worker.ts', import.meta.url), { type: 'module' }));
  const { renderThumbnail } = usePdfRenderer();
  const file = files[0];
  const { pages } = usePageThumbnails(file?.rawBuffer, 40);
  const first = pages[0];

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    renderThumbnail(file.rawBuffer, 1, PREVIEW_W * 2)
      .then((u) => !cancelled && setPreview(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [file, renderThumbnail]);

  const touch = <T,>(setter: (v: T) => void) => (v: T) => {
    setter(v);
    runner.reset();
  };

  const execute = () => {
    const buffer = file.rawBuffer.slice(0);
    const payload: WatermarkPayload = {
      fileBuffer: buffer,
      fileName: file.name,
      mode,
      text,
      imageBytes: image?.bytes.slice(0),
      imageType: image?.type,
      fontSize,
      color,
      opacity,
      rotationDegrees: rotation,
      position,
      layer,
      tile,
      pages: pagesText.trim() || undefined,
      fontFamily: family,
      bold: true,
      imageScale,
    };
    const transfer: Transferable[] = [buffer];
    if (payload.imageBytes) transfer.push(payload.imageBytes);
    void runner.run('WATERMARK_PDF', payload, transfer);
  };

  // --- CSS preview of a single stamp (tiles shown as a pattern)
  const scale = first ? PREVIEW_W / first.width : 1;
  const previewH = first ? first.height * scale : PREVIEW_W * 1.41;
  const stampStyle = useMemo<React.CSSProperties>(() => {
    const [v, h] = position.split('-') as [string, string | undefined];
    const vert = position === 'center' ? 'center' : v;
    const horiz = position === 'center' ? 'center' : h ?? 'center';
    const m = 24 * scale;
    return {
      position: 'absolute',
      top: vert === 'top' ? m : vert === 'bottom' ? undefined : '50%',
      bottom: vert === 'bottom' ? m : undefined,
      left: horiz === 'left' ? m : horiz === 'right' ? undefined : '50%',
      right: horiz === 'right' ? m : undefined,
      transform: `${vert === 'center' ? 'translateY(-50%) ' : ''}${horiz === 'center' ? 'translateX(-50%) ' : ''}rotate(${-rotation}deg)`,
      opacity,
      color,
      fontSize: fontSize * scale,
      fontWeight: 700,
      fontFamily: family === 'serif' ? 'Times New Roman, serif' : family === 'mono' ? 'Courier New, monospace' : 'Helvetica, Arial, sans-serif',
      whiteSpace: 'pre',
      lineHeight: 1.15,
      pointerEvents: 'none',
    };
  }, [position, rotation, opacity, color, fontSize, family, scale]);

  return (
    <ToolLayout
      tool={getTool('watermark')}
      files={files}
      onBack={onBack}
      onClearFiles={() => setFiles([])}
      onRemoveFile={() => setFiles([])}
      {...runner.layout}
      actionButtonLabel="Add watermark"
      onExecuteAction={execute}
      canExecute={mode === 'text' ? text.trim().length > 0 : !!image}
      options={
        <>
          <Segmented value={mode} onChange={touch(setMode)} options={[{ value: 'text', label: 'Text' }, { value: 'image', label: 'Image' }]} />
          {mode === 'text' ? (
            <>
              <Field label="Text">
                <textarea className="input min-h-[56px]" value={text} onChange={(e) => touch(setText)(e.target.value)} />
              </Field>
              <div className="flex items-end gap-3">
                <Field label="Font" className="flex-1">
                  <Segmented value={family} onChange={touch(setFamily)} size="sm" options={[{ value: 'sans', label: 'Sans' }, { value: 'serif', label: 'Serif' }, { value: 'mono', label: 'Mono' }]} />
                </Field>
                <ColorInput value={color} onChange={touch(setColor)} />
              </div>
              <Slider label="Size" min={8} max={160} value={fontSize} onChange={touch(setFontSize)} format={(v) => `${v} pt`} />
            </>
          ) : (
            <>
              {image ? (
                <div className="flex items-center gap-3">
                  <img src={image.url} alt="" className="w-14 h-14 object-contain border border-line bg-white" />
                  <Button size="sm" onClick={() => setImage(null)}>
                    Replace
                  </Button>
                </div>
              ) : (
                <GenericFileInput accept="image/*" compact title="Choose an image" onFileAccepted={(f) => void toPngOrJpeg(f).then(touch(setImage))} />
              )}
              <Slider label="Width" min={0.05} max={1} step={0.05} value={imageScale} onChange={touch(setImageScale)} format={(v) => `${Math.round(v * 100)}% of page`} />
            </>
          )}
          <Slider label="Opacity" min={0.05} max={1} step={0.05} value={opacity} onChange={touch(setOpacity)} format={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Rotation" min={-90} max={90} step={5} value={rotation} onChange={touch(setRotation)} format={(v) => `${v}°`} />
          <Toggle checked={tile} onChange={touch(setTile)} label="Repeat across the page" />
          {!tile && (
            <Field label="Position">
              <PositionGrid value={position} onChange={touch(setPosition)} />
            </Field>
          )}
          <Field label="Layer">
            <Segmented value={layer} onChange={touch(setLayer)} size="sm" options={[{ value: 'above', label: 'Over content' }, { value: 'below', label: 'Behind content' }]} />
          </Field>
          <Field label="Pages" hint="Leave empty for all pages, or e.g. 1-3, 7">
            <input className="input font-mono" value={pagesText} placeholder="All" onChange={(e) => touch(setPagesText)(e.target.value)} />
          </Field>
        </>
      }
      emptyState={<Dropzone multiple={false} onFilesAccepted={(f) => setFiles(f.slice(0, 1))} title="Choose a PDF to watermark" />}
    >
      <div className="flex justify-center py-2">
        <div className="relative bg-white shadow-page overflow-hidden" style={{ width: PREVIEW_W, height: previewH }}>
          {preview && <img src={preview} alt="" className="absolute inset-0 w-full h-full" style={{ zIndex: layer === 'below' ? 1 : 0, mixBlendMode: layer === 'below' ? 'multiply' : undefined }} />}
          <div className="absolute inset-0" style={{ zIndex: layer === 'below' ? 0 : 1 }}>
            {tile ? (
              <div className="absolute inset-0 flex flex-wrap content-around justify-around overflow-hidden">
                {Array.from({ length: 12 }).map((_, i) =>
                  mode === 'text' ? (
                    <span key={i} style={{ ...stampStyle, position: 'static', transform: `rotate(${-rotation}deg)` }}>
                      {text}
                    </span>
                  ) : image ? (
                    <img key={i} src={image.url} alt="" style={{ width: PREVIEW_W * imageScale * 0.5, opacity, transform: `rotate(${-rotation}deg)` }} />
                  ) : null
                )}
              </div>
            ) : mode === 'text' ? (
              <span style={stampStyle}>{text}</span>
            ) : image ? (
              <img src={image.url} alt="" style={{ ...stampStyle, width: PREVIEW_W * imageScale, fontSize: undefined }} />
            ) : null}
          </div>
        </div>
      </div>
      <p className="text-center text-2xs text-muted">Preview of page 1 (approximate)</p>
    </ToolLayout>
  );
};
