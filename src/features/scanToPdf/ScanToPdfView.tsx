import React, { useEffect, useRef, useState } from 'react';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Camera, Trash2, X } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { ImagesToPdfPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'scanToPdf',
  title: 'Scan to PDF',
  description: 'Capture pages with your camera and assemble them into a PDF.',
  icon: 'Camera',
  color: '#E53E3E',
  category: 'convert',
  acceptedFiles: 'multiple',
};

interface ScanToPdfViewProps {
  onBack: () => void;
}

interface Capture extends PDFFile {}

export const ScanToPdfView: React.FC<ScanToPdfViewProps> = ({ onBack }) => {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [streamActive, setStreamActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('../imageToPdf/imagesToPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  const startCamera = async () => {
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      streamRef.current = stream;
      if (videoRef.current) videoRef.current.srcObject = stream;
      setStreamActive(true);
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : 'Could not access the camera.');
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setStreamActive(false);
  };

  useEffect(() => () => stopCamera(), []);

  const captureFrame = () => {
    const video = videoRef.current;
    if (!video || video.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d')!;
    ctx.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (!blob) return;
        blob.arrayBuffer().then((buffer) => {
          const previewUrl = URL.createObjectURL(blob);
          memoryManager.registerUrl(previewUrl);
          setCaptures((prev) => [
            ...prev,
            {
              id: `scan_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
              name: `scan_page_${prev.length + 1}.jpg`,
              size: buffer.byteLength,
              pageCount: 0,
              rawBuffer: buffer,
              previewUrls: [previewUrl],
            },
          ]);
          setResult(null);
          resetState();
        });
      },
      'image/jpeg',
      0.9
    );
  };

  const removeCapture = (id: string) => {
    setCaptures((prev) => {
      const target = prev.find((c) => c.id === id);
      target?.previewUrls.forEach((u) => memoryManager.revokeUrl(u));
      return prev.filter((c) => c.id !== id);
    });
    setResult(null);
  };

  const handleClearFiles = () => {
    captures.forEach((c) => c.previewUrls.forEach((u) => memoryManager.revokeUrl(u)));
    setCaptures([]);
    setResult(null);
    resetState();
  };

  const executeAssemble = async () => {
    if (captures.length === 0) return;
    try {
      const images = captures.map((c) => ({ bytes: c.rawBuffer.slice(0), type: 'jpg' as const }));
      const payload: ImagesToPdfPayload = {
        images,
        orientation: 'auto',
        margin: 'none',
        pageSize: 'fit',
        fileName: 'scanned_document',
      };
      const transferables = images.map((i) => i.bytes);
      const res = await runTask<ImagesToPdfPayload>('IMAGES_TO_PDF', payload, transferables);
      setResult(res);
    } catch (err) {
      console.error('Scan to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, 'application/pdf');
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#E53E3E"
      files={captures}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={removeCapture}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'scanned_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Assemble PDF"
      onExecuteAction={executeAssemble}
      canExecute={captures.length > 0}
    >
      <div className="space-y-6">
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Camera className="w-5 h-5 text-[#E53E3E]" />
            <span>Camera Capture</span>
          </h3>

          {cameraError && (
            <p className="text-xs text-rose-600 dark:text-rose-400">{cameraError}</p>
          )}

          <div className="relative bg-slate-950 rounded-xl overflow-hidden aspect-video flex items-center justify-center">
            {streamActive ? (
              <video ref={videoRef} autoPlay playsInline className="w-full h-full object-contain" />
            ) : (
              <p className="text-sm text-slate-400">Camera is off</p>
            )}
          </div>

          <div className="flex gap-2">
            {!streamActive ? (
              <button
                onClick={startCamera}
                className="px-5 py-2.5 bg-[#E53E3E] text-white font-semibold text-sm rounded-xl shadow-sm"
              >
                Start Camera
              </button>
            ) : (
              <>
                <button
                  onClick={captureFrame}
                  className="px-5 py-2.5 bg-[#E53E3E] text-white font-semibold text-sm rounded-xl shadow-sm"
                >
                  Capture Page
                </button>
                <button
                  onClick={stopCamera}
                  className="px-4 py-2.5 bg-slate-100 dark:bg-slate-800 text-slate-700 dark:text-slate-200 font-semibold text-sm rounded-xl flex items-center gap-1.5"
                >
                  <X className="w-4 h-4" />
                  <span>Stop</span>
                </button>
              </>
            )}
          </div>
        </div>

        {captures.length > 0 && (
          <div>
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 mb-3">
              {captures.length} page{captures.length === 1 ? '' : 's'} captured
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
              {captures.map((c, idx) => (
                <div key={c.id} className="relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2 shadow-xs">
                  <span className="absolute top-1 left-1 w-5 h-5 rounded-full bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300 text-[10px] font-bold flex items-center justify-center z-10">
                    {idx + 1}
                  </span>
                  <div className="aspect-square bg-slate-50 dark:bg-slate-950 rounded-lg overflow-hidden flex items-center justify-center">
                    <img src={c.previewUrls[0]} alt={c.name} className="max-w-full max-h-full object-contain" />
                  </div>
                  <button
                    onClick={() => removeCapture(c.id)}
                    className="absolute top-1 right-1 p-1 bg-white/90 dark:bg-slate-900/90 rounded-md text-slate-400 hover:text-rose-600"
                    title="Remove"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </ToolLayout>
  );
};
