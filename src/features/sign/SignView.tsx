import React, { useEffect, useRef, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PositionGrid } from '../../components/common/PositionGrid';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { computeAnchor } from '../../services/pdfStampPosition';
import { PenLine, Type as TypeIcon, Upload, Eraser } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { StampSignaturePayload, WatermarkPosition, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'sign',
  title: 'Sign PDF',
  description: 'Draw, type, or upload a signature and place it on a page.',
  icon: 'PenLine',
  color: '#0284C7',
  category: 'security',
  acceptedFiles: 'single',
};

interface SignViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const SignView: React.FC<SignViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [totalPages, setTotalPages] = useState(1);
  const [pageSizePt, setPageSizePt] = useState({ width: 595.28, height: 841.89 }); // A4 default until the real page loads
  const [mode, setMode] = useState<'draw' | 'type' | 'upload'>('draw');
  const [typedText, setTypedText] = useState('Your Name');
  const [uploadedImage, setUploadedImage] = useState<{ bytes: ArrayBuffer; dataUrl: string } | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [position, setPosition] = useState<WatermarkPosition>('bottom-right');
  const [sigWidthPt, setSigWidthPt] = useState(150);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawingRef = useRef(false);
  const hasDrawnRef = useRef(false);

  const { getPageCount, loadDocument } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./sign.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length > 0) {
      getPageCount(files[0].rawBuffer)
        .then((count) => {
          setTotalPages(count);
          setPageIndex(count - 1);
        })
        .catch(() => setTotalPages(1));
    }
  }, [files, getPageCount]);

  // Track the actual size (in PDF points) of the currently-selected page,
  // since a Letter/custom-sized document would otherwise get its signature
  // mispositioned against a hardcoded A4 assumption.
  useEffect(() => {
    if (files.length === 0) return;
    let cancelled = false;
    loadDocument(files[0].rawBuffer)
      .then(async (doc) => {
        try {
          if (cancelled) return;
          const page = await doc.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          if (!cancelled) setPageSizePt({ width: viewport.width, height: viewport.height });
        } finally {
          memoryManager.destroyPdfDocument(doc);
        }
      })
      .catch(() => {
        if (!cancelled) setPageSizePt({ width: 595.28, height: 841.89 });
      });
    return () => {
      cancelled = true;
    };
  }, [files, pageIndex, loadDocument]);

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx?.clearRect(0, 0, canvas.width, canvas.height);
    hasDrawnRef.current = false;
  };

  const getCanvasPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * (canvas.width / rect.width), y: (e.clientY - rect.top) * (canvas.height / rect.height) };
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    drawingRef.current = true;
    hasDrawnRef.current = true;
    const ctx = canvasRef.current!.getContext('2d')!;
    const { x, y } = getCanvasPoint(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current!.getContext('2d')!;
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#0f172a';
    const { x, y } = getCanvasPoint(e);
    ctx.lineTo(x, y);
    ctx.stroke();
  };
  const handlePointerUp = () => {
    drawingRef.current = false;
  };

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const buildSignatureBytes = async (): Promise<ArrayBuffer> => {
    if (mode === 'upload') {
      if (!uploadedImage) throw new Error('Upload a signature image first.');
      return uploadedImage.bytes;
    }
    if (mode === 'draw') {
      if (!hasDrawnRef.current) throw new Error('Draw a signature first.');
      const dataUrl = canvasRef.current!.toDataURL('image/png');
      const res = await fetch(dataUrl);
      return res.arrayBuffer();
    }
    // typed
    const canvas = document.createElement('canvas');
    canvas.width = 600;
    canvas.height = 160;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.font = "italic 64px 'Segoe Script', 'Brush Script MT', cursive";
    ctx.fillStyle = '#0f172a';
    ctx.textBaseline = 'middle';
    ctx.fillText(typedText || 'Signature', 20, canvas.height / 2);
    const dataUrl = canvas.toDataURL('image/png');
    const res = await fetch(dataUrl);
    return res.arrayBuffer();
  };

  const executeSign = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const signatureImageBytes = await buildSignatureBytes();
      const sigHeightPt = sigWidthPt * 0.35;
      const { x, y } = computeAnchor(pageSizePt.width, pageSizePt.height, sigWidthPt, sigHeightPt, position, 36);

      const bufferCopy = file.rawBuffer.slice(0);
      const payload: StampSignaturePayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        signatureImageBytes,
        pageIndex,
        xPt: x,
        yPt: y,
        widthPt: sigWidthPt,
        heightPt: sigHeightPt,
      };
      const res = await runTask<StampSignaturePayload>('STAMP_SIGNATURE', payload, [bufferCopy, signatureImageBytes]);
      setResult(res);
    } catch (err) {
      console.error('Sign error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  const canExecute = files.length > 0 && (mode !== 'upload' || !!uploadedImage);

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#0284C7"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'signed_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Apply Signature"
      onExecuteAction={executeSign}
      canExecute={canExecute}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF to sign" subtitle="Draw, type, or upload your signature" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-5">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <PenLine className="w-5 h-5 text-[#0284C7]" />
            <span>Create Your Signature</span>
          </h3>

          <div className="grid grid-cols-3 gap-2">
            {([
              { id: 'draw', label: 'Draw', icon: PenLine },
              { id: 'type', label: 'Type', icon: TypeIcon },
              { id: 'upload', label: 'Upload', icon: Upload },
            ] as const).map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={`p-2.5 rounded-lg border text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors ${
                  mode === id
                    ? 'border-[#0284C7] bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300'
                    : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                }`}
              >
                <Icon className="w-3.5 h-3.5" />
                <span>{label}</span>
              </button>
            ))}
          </div>

          {mode === 'draw' && (
            <div className="space-y-2">
              <canvas
                ref={canvasRef}
                width={600}
                height={160}
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerLeave={handlePointerUp}
                className="w-full h-40 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg touch-none cursor-crosshair"
              />
              <button onClick={clearCanvas} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-500 hover:text-rose-600">
                <Eraser className="w-3.5 h-3.5" />
                <span>Clear</span>
              </button>
            </div>
          )}

          {mode === 'type' && (
            <div className="space-y-2">
              <input
                type="text"
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-sky-500"
                placeholder="Your Name"
              />
              <div className="w-full h-24 flex items-center px-4 bg-slate-50 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden">
                <span className="text-4xl italic text-slate-900 dark:text-white" style={{ fontFamily: "'Segoe Script', 'Brush Script MT', cursive" }}>
                  {typedText || 'Signature'}
                </span>
              </div>
            </div>
          )}

          {mode === 'upload' && (
            <div>
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const bytes = await file.arrayBuffer();
                  setUploadedImage({ bytes, dataUrl: URL.createObjectURL(file) });
                }}
                className="w-full text-xs text-slate-600 dark:text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-sky-100 file:text-sky-800 dark:file:bg-sky-950 dark:file:text-sky-300 file:text-xs file:font-semibold"
              />
              {uploadedImage && (
                <img src={uploadedImage.dataUrl} alt="Signature" className="mt-2 max-h-24 border border-slate-200 dark:border-slate-700 rounded-lg p-2 bg-white" />
              )}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800">
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Page</label>
              <select
                value={pageIndex}
                onChange={(e) => setPageIndex(parseInt(e.target.value, 10))}
                className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white"
              >
                {Array.from({ length: totalPages }, (_, i) => (
                  <option key={i} value={i}>Page {i + 1}</option>
                ))}
              </select>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5 mt-3">Size</label>
              <input
                type="range"
                min={60}
                max={300}
                value={sigWidthPt}
                onChange={(e) => setSigWidthPt(parseInt(e.target.value, 10))}
                className="w-full accent-[#0284C7]"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Position</label>
              <PositionGrid value={position} onChange={setPosition} accentColor="#0284C7" />
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
