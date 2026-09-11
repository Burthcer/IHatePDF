import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { PositionGrid } from '../../components/common/PositionGrid';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { memoryManager } from '../../services/memoryManager';
import { Stamp, Type, Image as ImageIcon } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { WatermarkPayload, WatermarkPosition, ProcessedPdfResult } from '../../types/worker';

const WATERMARK_TOOL_METADATA: ToolMetadata = {
  id: 'watermark',
  title: 'Watermark',
  description: 'Stamp text or an image onto every page.',
  icon: 'Stamp',
  color: '#F59E0B',
  category: 'edit',
  acceptedFiles: 'single',
};

interface WatermarkViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

export const WatermarkView: React.FC<WatermarkViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [mode, setMode] = useState<'text' | 'image'>('text');
  const [text, setText] = useState('CONFIDENTIAL');
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [fontSize, setFontSize] = useState(48);
  const [color, setColor] = useState('#E53E3E');
  const [opacity, setOpacity] = useState(0.3);
  const [rotationDegrees, setRotationDegrees] = useState(45);
  const [position, setPosition] = useState<WatermarkPosition>('center');
  const [layer, setLayer] = useState<'above' | 'below'>('above');
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./watermark.worker.ts', import.meta.url), { type: 'module' })
    );

  const handleFilesAccepted = (acceptedFiles: PDFFile[]) => {
    const single = acceptedFiles.slice(0, 1);
    setFiles(single);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setResult(null);
    resetState();
  };

  const executeWatermark = async () => {
    if (files.length === 0) return;
    const file = files[0];

    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const transferables: Transferable[] = [bufferCopy];

      let imageBytes: ArrayBuffer | undefined;
      let imageType: 'png' | 'jpg' | undefined;
      if (mode === 'image' && imageFile) {
        imageBytes = await imageFile.arrayBuffer();
        imageType = imageFile.type.includes('jpeg') || imageFile.type.includes('jpg') ? 'jpg' : 'png';
        transferables.push(imageBytes);
      }

      const payload: WatermarkPayload = {
        fileBuffer: bufferCopy,
        fileName: file.name,
        mode,
        text: mode === 'text' ? text : undefined,
        imageBytes,
        imageType,
        fontSize,
        color,
        opacity,
        rotationDegrees,
        position,
        layer,
      };

      const res = await runTask<WatermarkPayload>('WATERMARK_PDF', payload, transferables);
      setResult(res);
    } catch (err) {
      console.error('Watermark error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  const canExecute = files.length > 0 && (mode === 'text' ? text.trim().length > 0 : !!imageFile);

  return (
    <ToolLayout
      tool={WATERMARK_TOOL_METADATA}
      accentColor="#F59E0B"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={handleClearFiles}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={result?.buffer || null}
      resultFileName={result?.fileName || 'watermarked_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Apply Watermark"
      onExecuteAction={executeWatermark}
      canExecute={canExecute}
    >
      {files.length === 0 ? (
        <Dropzone
          multiple={false}
          onFilesAccepted={handleFilesAccepted}
          title="Select a PDF file"
          subtitle="Stamp text or an image onto every page"
        />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-6">
          <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
            <Stamp className="w-5 h-5 text-[#F59E0B]" />
            <span>Watermark Settings</span>
          </h3>

          {/* Mode toggle */}
          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => setMode('text')}
              className={`p-3 rounded-lg border text-left flex items-center gap-2.5 transition-colors ${
                mode === 'text'
                  ? 'border-[#F59E0B] bg-amber-50 dark:bg-amber-950/20'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <Type className="w-4 h-4 text-[#F59E0B]" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Text Stamp</span>
            </button>
            <button
              type="button"
              onClick={() => setMode('image')}
              className={`p-3 rounded-lg border text-left flex items-center gap-2.5 transition-colors ${
                mode === 'image'
                  ? 'border-[#F59E0B] bg-amber-50 dark:bg-amber-950/20'
                  : 'border-slate-200 dark:border-slate-700 hover:bg-slate-50 dark:hover:bg-slate-800'
              }`}
            >
              <ImageIcon className="w-4 h-4 text-[#F59E0B]" />
              <span className="text-sm font-semibold text-slate-800 dark:text-slate-200">Image Stamp</span>
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
            <div className="space-y-4">
              {mode === 'text' ? (
                <>
                  <div>
                    <label htmlFor="wm-text" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                      Watermark Text
                    </label>
                    <input
                      id="wm-text"
                      type="text"
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <label htmlFor="wm-fontsize" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        Font Size
                      </label>
                      <input
                        id="wm-fontsize"
                        type="number"
                        min={8}
                        max={200}
                        value={fontSize}
                        onChange={(e) => setFontSize(parseInt(e.target.value, 10) || 48)}
                        className="w-full px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm font-semibold text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-amber-500"
                      />
                    </div>
                    <div>
                      <label htmlFor="wm-color" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                        Color
                      </label>
                      <input
                        id="wm-color"
                        type="color"
                        value={color}
                        onChange={(e) => setColor(e.target.value)}
                        className="w-full h-[34px] bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg cursor-pointer"
                      />
                    </div>
                  </div>
                </>
              ) : (
                <div>
                  <label htmlFor="wm-image" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                    Logo / Image (PNG or JPG)
                  </label>
                  <input
                    id="wm-image"
                    type="file"
                    accept="image/png,image/jpeg"
                    onChange={(e) => setImageFile(e.target.files?.[0] || null)}
                    className="w-full text-xs text-slate-600 dark:text-slate-400 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:bg-amber-100 file:text-amber-800 dark:file:bg-amber-950 dark:file:text-amber-300 file:text-xs file:font-semibold"
                  />
                  {imageFile && (
                    <p className="text-xs text-slate-500 mt-1.5">{imageFile.name}</p>
                  )}
                </div>
              )}

              <div>
                <label htmlFor="wm-opacity" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Opacity: {Math.round(opacity * 100)}%
                </label>
                <input
                  id="wm-opacity"
                  type="range"
                  min={0.05}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => setOpacity(parseFloat(e.target.value))}
                  className="w-full accent-[#F59E0B]"
                />
              </div>

              <div>
                <label htmlFor="wm-rotation" className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">
                  Rotation: {rotationDegrees}°
                </label>
                <input
                  id="wm-rotation"
                  type="range"
                  min={0}
                  max={360}
                  step={5}
                  value={rotationDegrees}
                  onChange={(e) => setRotationDegrees(parseInt(e.target.value, 10))}
                  className="w-full accent-[#F59E0B]"
                />
              </div>

              <div>
                <span className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1.5">Layer</span>
                <div className="grid grid-cols-2 gap-2">
                  {(['above', 'below'] as const).map((l) => (
                    <button
                      key={l}
                      type="button"
                      onClick={() => setLayer(l)}
                      className={`px-3 py-1.5 rounded-lg border text-xs font-semibold capitalize transition-colors ${
                        layer === l
                          ? 'border-[#F59E0B] bg-amber-50 dark:bg-amber-950/20 text-amber-900 dark:text-amber-200'
                          : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800'
                      }`}
                    >
                      {l} content
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-2">Position</label>
              <PositionGrid value={position} onChange={setPosition} accentColor="#F59E0B" />
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
