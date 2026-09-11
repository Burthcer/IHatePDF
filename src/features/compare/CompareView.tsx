import React, { useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { GitCompare, AlertTriangle } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';

const TOOL_METADATA: ToolMetadata = {
  id: 'compare',
  title: 'Compare PDF',
  description: 'Highlight visual differences between two versions of a PDF, page by page.',
  icon: 'GitCompare',
  color: '#8B5CF6',
  category: 'edit',
  acceptedFiles: 'single',
};

interface CompareViewProps {
  onBack: () => void;
}

interface PageDiff {
  pageNumber: number;
  status: 'match' | 'changed' | 'onlyInA' | 'onlyInB';
  similarity: number;
  imageA: string | null;
  imageB: string | null;
  diffImage: string | null;
}

const RENDER_WIDTH = 700;
const DIFF_THRESHOLD = 32; // per-channel delta to count a pixel as "changed"

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}

async function diffPages(dataUrlA: string, dataUrlB: string): Promise<{ diffImage: string; similarity: number }> {
  const [imgA, imgB] = await Promise.all([loadImage(dataUrlA), loadImage(dataUrlB)]);
  const width = Math.max(imgA.width, imgB.width);
  const height = Math.max(imgA.height, imgB.height);

  const canvasA = document.createElement('canvas');
  canvasA.width = width;
  canvasA.height = height;
  const ctxA = canvasA.getContext('2d')!;
  ctxA.fillStyle = '#ffffff';
  ctxA.fillRect(0, 0, width, height);
  ctxA.drawImage(imgA, 0, 0);

  const canvasB = document.createElement('canvas');
  canvasB.width = width;
  canvasB.height = height;
  const ctxB = canvasB.getContext('2d')!;
  ctxB.fillStyle = '#ffffff';
  ctxB.fillRect(0, 0, width, height);
  ctxB.drawImage(imgB, 0, 0);

  const dataA = ctxA.getImageData(0, 0, width, height);
  const dataB = ctxB.getImageData(0, 0, width, height);

  const outCanvas = document.createElement('canvas');
  outCanvas.width = width;
  outCanvas.height = height;
  const ctxOut = outCanvas.getContext('2d')!;
  const out = ctxOut.createImageData(width, height);

  let changedPixels = 0;
  const totalPixels = width * height;

  for (let i = 0; i < dataA.data.length; i += 4) {
    const dr = Math.abs(dataA.data[i] - dataB.data[i]);
    const dg = Math.abs(dataA.data[i + 1] - dataB.data[i + 1]);
    const db = Math.abs(dataA.data[i + 2] - dataB.data[i + 2]);
    const changed = dr > DIFF_THRESHOLD || dg > DIFF_THRESHOLD || db > DIFF_THRESHOLD;

    if (changed) {
      changedPixels++;
      out.data[i] = 239;
      out.data[i + 1] = 68;
      out.data[i + 2] = 68;
      out.data[i + 3] = 255;
    } else {
      const gray = Math.round((dataB.data[i] + dataB.data[i + 1] + dataB.data[i + 2]) / 3);
      const light = 255 - (255 - gray) * 0.15;
      out.data[i] = light;
      out.data[i + 1] = light;
      out.data[i + 2] = light;
      out.data[i + 3] = 255;
    }
  }

  ctxOut.putImageData(out, 0, 0);
  const similarity = 1 - changedPixels / totalPixels;
  return { diffImage: outCanvas.toDataURL('image/jpeg', 0.85), similarity };
}

export const CompareView: React.FC<CompareViewProps> = ({ onBack }) => {
  const [fileA, setFileA] = useState<PDFFile | null>(null);
  const [fileB, setFileB] = useState<PDFFile | null>(null);
  const [diffs, setDiffs] = useState<PageDiff[] | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { renderAllPageImages } = usePdfRenderer();

  const handleFileA = (files: PDFFile[]) => {
    if (files[0]) setFileA(files[0]);
    setDiffs(null);
  };
  const handleFileB = (files: PDFFile[]) => {
    if (files[0]) setFileB(files[0]);
    setDiffs(null);
  };

  const handleClearFiles = () => {
    setFileA(null);
    setFileB(null);
    setDiffs(null);
    setError(null);
  };

  const removeFile = (id: string) => {
    if (fileA?.id === id) setFileA(null);
    if (fileB?.id === id) setFileB(null);
    setDiffs(null);
  };

  const executeCompare = async () => {
    if (!fileA || !fileB) return;
    setIsProcessing(true);
    setError(null);
    setDiffs(null);
    try {
      setStage('Rendering first document...');
      setProgress(10);
      const pagesA = await renderAllPageImages(fileA.rawBuffer.slice(0), RENDER_WIDTH);
      setStage('Rendering second document...');
      setProgress(40);
      const pagesB = await renderAllPageImages(fileB.rawBuffer.slice(0), RENDER_WIDTH);

      const maxPages = Math.max(pagesA.length, pagesB.length);
      const results: PageDiff[] = [];

      for (let i = 0; i < maxPages; i++) {
        const a = pagesA[i];
        const b = pagesB[i];
        setStage(`Comparing page ${i + 1} of ${maxPages}...`);
        setProgress(40 + Math.round(((i + 1) / maxPages) * 55));

        if (a && !b) {
          results.push({ pageNumber: i + 1, status: 'onlyInA', similarity: 0, imageA: a.dataUrl, imageB: null, diffImage: null });
        } else if (!a && b) {
          results.push({ pageNumber: i + 1, status: 'onlyInB', similarity: 0, imageA: null, imageB: b.dataUrl, diffImage: null });
        } else {
          const { diffImage, similarity } = await diffPages(a.dataUrl, b.dataUrl);
          results.push({
            pageNumber: i + 1,
            status: similarity > 0.995 ? 'match' : 'changed',
            similarity,
            imageA: a.dataUrl,
            imageB: b.dataUrl,
            diffImage,
          });
        }
      }

      setProgress(100);
      setStage('Comparison complete.');
      setDiffs(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to compare documents.');
    } finally {
      setIsProcessing(false);
    }
  };

  const files = [fileA, fileB].filter((f): f is PDFFile => f !== null);
  const changedCount = diffs?.filter((d) => d.status !== 'match').length ?? 0;

  return (
    <ToolLayout
      tool={TOOL_METADATA}
      accentColor="#8B5CF6"
      files={files}
      onBack={onBack}
      onClearFiles={handleClearFiles}
      onRemoveFile={removeFile}
      isProcessing={isProcessing}
      progress={progress}
      stage={stage}
      error={error}
      resultBuffer={null}
      actionButtonLabel="Compare Documents"
      onExecuteAction={executeCompare}
      canExecute={!!fileA && !!fileB}
    >
      <div className="space-y-6">
        {(!fileA || !fileB) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Original</p>
              {fileA ? (
                <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
                  {fileA.name}
                </div>
              ) : (
                <Dropzone multiple={false} onFilesAccepted={handleFileA} title="Select original PDF" subtitle="The base version" />
              )}
            </div>
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">Modified</p>
              {fileB ? (
                <div className="p-4 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-semibold text-slate-700 dark:text-slate-200 truncate">
                  {fileB.name}
                </div>
              ) : (
                <Dropzone multiple={false} onFilesAccepted={handleFileB} title="Select modified PDF" subtitle="The version to compare against" />
              )}
            </div>
          </div>
        )}

        {fileA && fileB && !diffs && !isProcessing && (
          <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-3">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white flex items-center gap-2">
              <GitCompare className="w-5 h-5 text-[#8B5CF6]" />
              <span>Ready to Compare</span>
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              Renders each page of both documents and highlights pixel-level differences in red.
              This compares visual appearance, not underlying text or metadata.
            </p>
          </div>
        )}

        {diffs && (
          <div className="space-y-5">
            <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-5 shadow-sm flex items-center gap-3">
              {changedCount === 0 ? (
                <>
                  <GitCompare className="w-5 h-5 text-emerald-600" />
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    No visual differences found across {diffs.length} page{diffs.length === 1 ? '' : 's'}.
                  </p>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-amber-500" />
                  <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">
                    {changedCount} of {diffs.length} page{diffs.length === 1 ? '' : 's'} differ.
                  </p>
                </>
              )}
            </div>

            {diffs.map((d) => (
              <div key={d.pageNumber} className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-4 shadow-sm">
                <div className="flex items-center justify-between mb-3">
                  <h4 className="text-sm font-bold text-slate-800 dark:text-slate-200">Page {d.pageNumber}</h4>
                  {d.status === 'match' && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">
                      Identical
                    </span>
                  )}
                  {d.status === 'changed' && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-rose-100 dark:bg-rose-950 text-rose-700 dark:text-rose-300">
                      {Math.round((1 - d.similarity) * 100)}% changed
                    </span>
                  )}
                  {d.status === 'onlyInA' && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300">
                      Removed
                    </span>
                  )}
                  {d.status === 'onlyInB' && (
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded-md bg-sky-100 dark:bg-sky-950 text-sky-700 dark:text-sky-300">
                      Added
                    </span>
                  )}
                </div>

                {d.status === 'changed' && d.diffImage ? (
                  <img src={d.diffImage} alt={`Diff for page ${d.pageNumber}`} className="w-full rounded-lg border border-slate-200 dark:border-slate-800" />
                ) : (
                  <img
                    src={d.imageA || d.imageB || ''}
                    alt={`Page ${d.pageNumber}`}
                    className="w-full rounded-lg border border-slate-200 dark:border-slate-800"
                  />
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </ToolLayout>
  );
};
