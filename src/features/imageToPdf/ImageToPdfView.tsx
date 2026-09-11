import React, { useRef, useState } from 'react';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { UploadCloud, GripVertical, Trash2, ImagePlus } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type {
  ImagesToPdfPayload,
  ImagePageOrientation,
  ImagePageMargin,
  ImagePageSize,
  ProcessedPdfResult,
} from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'imageToPdf',
  title: 'JPG to PDF',
  description: 'Convert JPG/PNG images to PDF, one page per image.',
  icon: 'ImagePlus',
  color: '#0284C7',
  category: 'convert',
  acceptedFiles: 'multiple',
};

interface QueuedImage extends PDFFile {
  imageType: 'png' | 'jpg';
}

interface ImageToPdfViewProps {
  onBack: () => void;
}

function inferType(file: File): 'png' | 'jpg' {
  return file.type.includes('png') ? 'png' : 'jpg';
}

export const ImageToPdfView: React.FC<ImageToPdfViewProps> = ({ onBack }) => {
  const [files, setFiles] = useState<QueuedImage[]>([]);
  const [orientation, setOrientation] = useState<ImagePageOrientation>('auto');
  const [margin, setMargin] = useState<ImagePageMargin>('small');
  const [pageSize, setPageSize] = useState<ImagePageSize>('a4');
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const dragIndexRef = useRef<number | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./imagesToPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  const addFiles = async (fileList: FileList | File[]) => {
    const accepted = Array.from(fileList).filter((f) => /image\/(png|jpe?g)/.test(f.type));
    const queued: QueuedImage[] = await Promise.all(
      accepted.map(async (file) => {
        const buffer = await file.arrayBuffer();
        const previewUrl = URL.createObjectURL(file);
        memoryManager.registerUrl(previewUrl);
        return {
          id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
          name: file.name,
          size: file.size,
          pageCount: 0,
          rawBuffer: buffer,
          previewUrls: [previewUrl],
          imageType: inferType(file),
        };
      })
    );
    setFiles((prev) => [...prev, ...queued]);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    files.forEach((f) => f.previewUrls.forEach((u) => memoryManager.revokeUrl(u)));
    setFiles([]);
    setResult(null);
    resetState();
  };

  const removeImage = (id: string) => {
    setFiles((prev) => {
      const target = prev.find((f) => f.id === id);
      target?.previewUrls.forEach((u) => memoryManager.revokeUrl(u));
      return prev.filter((f) => f.id !== id);
    });
    setResult(null);
  };

  const handleDragStart = (index: number) => {
    dragIndexRef.current = index;
  };
  const handleDragOver = (e: React.DragEvent) => e.preventDefault();
  const handleDropReorder = (targetIndex: number) => {
    const sourceIndex = dragIndexRef.current;
    dragIndexRef.current = null;
    if (sourceIndex === null || sourceIndex === targetIndex) return;
    setFiles((prev) => {
      const reordered = [...prev];
      const [moved] = reordered.splice(sourceIndex, 1);
      reordered.splice(targetIndex, 0, moved);
      return reordered;
    });
    setResult(null);
  };

  const executeConvert = async () => {
    if (files.length === 0) return;
    try {
      const images = files.map((f) => ({ bytes: f.rawBuffer.slice(0), type: f.imageType }));
      const payload: ImagesToPdfPayload = {
        images,
        orientation,
        margin,
        pageSize,
        fileName: files.length === 1 ? files[0].name : 'images',
      };
      const transferables = images.map((i) => i.bytes);
      const res = await runTask<ImagesToPdfPayload>('IMAGES_TO_PDF', payload, transferables);
      setResult(res);
    } catch (err) {
      console.error('Image to PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName, 'application/pdf');
  };

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#0284C7"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={removeImage}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'images.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Convert to PDF"
      onExecuteAction={executeConvert}
      canExecute={files.length > 0}
    >
      {files.length === 0 ? (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          role="button"
          tabIndex={0}
          className="relative flex flex-col items-center justify-center p-8 sm:p-12 border-2 border-dashed border-slate-300 dark:border-slate-700 rounded-2xl cursor-pointer hover:border-[#0284C7] transition-colors"
        >
          <input
            ref={inputRef}
            type="file"
            accept="image/png,image/jpeg"
            multiple
            onChange={(e) => {
              if (e.target.files) addFiles(e.target.files);
              e.target.value = '';
            }}
            className="hidden"
          />
          <div className="flex flex-col items-center text-center space-y-4">
            <div className="w-16 h-16 rounded-2xl bg-[#0284C7] flex items-center justify-center text-white shadow-md">
              <UploadCloud className="w-8 h-8" />
            </div>
            <div>
              <h3 className="text-xl font-bold text-slate-900 dark:text-white">Select JPG/PNG images</h3>
              <p className="text-sm text-slate-500 dark:text-slate-400 mt-1">Drop multiple images, in the order you want them</p>
            </div>
            <button type="button" className="px-6 py-2.5 bg-[#0284C7] text-white font-semibold text-sm rounded-xl shadow-sm">
              Select Images
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <span className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Orientation</span>
                <div className="flex gap-1.5">
                  {(['auto', 'portrait', 'landscape'] as const).map((o) => (
                    <button
                      key={o}
                      onClick={() => setOrientation(o)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold capitalize border transition-colors ${
                        orientation === o
                          ? 'border-[#0284C7] bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {o}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Margin</span>
                <div className="flex gap-1.5">
                  {(['none', 'small', 'big'] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMargin(m)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold capitalize border transition-colors ${
                        margin === m
                          ? 'border-[#0284C7] bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Page Size</span>
                <div className="flex gap-1.5">
                  {(['a4', 'letter', 'fit'] as const).map((p) => (
                    <button
                      key={p}
                      onClick={() => setPageSize(p)}
                      className={`flex-1 px-2 py-1.5 rounded-lg text-xs font-semibold uppercase border transition-colors ${
                        pageSize === p
                          ? 'border-[#0284C7] bg-sky-50 dark:bg-sky-950/30 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300'
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200">
              {files.length} image{files.length === 1 ? '' : 's'} (drag to reorder)
            </h3>
            <label
              htmlFor="add-more-images"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 text-xs font-semibold rounded-lg cursor-pointer text-slate-700 dark:text-slate-200"
            >
              <ImagePlus className="w-3.5 h-3.5" />
              <span>Add More</span>
            </label>
            <input
              id="add-more-images"
              type="file"
              accept="image/png,image/jpeg"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) addFiles(e.target.files);
                e.target.value = '';
              }}
            />
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {files.map((file, idx) => (
              <div
                key={file.id}
                draggable
                onDragStart={() => handleDragStart(idx)}
                onDragOver={handleDragOver}
                onDrop={() => handleDropReorder(idx)}
                className="group relative bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-2 shadow-xs cursor-grab active:cursor-grabbing"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="w-5 h-5 rounded-full bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300 text-[10px] font-bold flex items-center justify-center">
                    {idx + 1}
                  </span>
                  <GripVertical className="w-3.5 h-3.5 text-slate-300 dark:text-slate-600" />
                </div>
                <div className="aspect-square bg-slate-50 dark:bg-slate-950 rounded-lg overflow-hidden flex items-center justify-center">
                  <img src={file.previewUrls[0]} alt={file.name} className="max-w-full max-h-full object-contain" />
                </div>
                <button
                  onClick={() => removeImage(file.id)}
                  className="absolute top-1 right-1 p-1 bg-white/90 dark:bg-slate-900/90 rounded-md text-slate-400 hover:text-rose-600 opacity-0 group-hover:opacity-100 transition-opacity"
                  title="Remove"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
