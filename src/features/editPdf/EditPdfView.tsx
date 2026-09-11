import React, { useEffect, useRef, useState } from 'react';
import { Dropzone } from '../../components/common/Dropzone';
import { ToolLayout } from '../../components/layout/ToolLayout';
import { useWorkerBridge } from '../../hooks/useWorkerBridge';
import { usePdfRenderer } from '../../hooks/usePdfRenderer';
import { memoryManager } from '../../services/memoryManager';
import { Type as TypeIcon, ImagePlus, Trash2, Bold } from 'lucide-react';
import type { PDFFile, ToolMetadata } from '../../types/pdf';
import type { EditElement, EditPdfPayload, ProcessedPdfResult } from '../../types/worker';

const TOOL_METADATA: ToolMetadata = {
  id: 'editPdf',
  title: 'Edit PDF',
  description: 'Add text and images anywhere on the page, then save the result.',
  icon: 'PenSquare',
  color: '#F59E0B',
  category: 'edit',
  acceptedFiles: 'single',
};

interface EditPdfViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

interface EditorElement {
  id: string;
  el: EditElement;
  naturalAspect?: number; // width/height, for images
  previewUrl?: string; // object URL, for images
}

const DISPLAY_WIDTH = 700;

export const EditPdfView: React.FC<EditPdfViewProps> = ({ initialFiles = [], onBack }) => {
  const [files, setFiles] = useState<PDFFile[]>(initialFiles);
  const [totalPages, setTotalPages] = useState(1);
  const [pageIndex, setPageIndex] = useState(0);
  const [pageSizePt, setPageSizePt] = useState({ width: 595.28, height: 841.89 });
  const [pageImage, setPageImage] = useState<string | null>(null);
  const [elements, setElements] = useState<EditorElement[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [result, setResult] = useState<ProcessedPdfResult | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ id: string; startPx: number; startPy: number; origXPt: number; origYPt: number } | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const { getPageCount, loadDocument, renderPage } = usePdfRenderer();
  const { runTask, isProcessing, progress, stage, error, resetState } =
    useWorkerBridge<ProcessedPdfResult>(
      () => new Worker(new URL('./editPdf.worker.ts', import.meta.url), { type: 'module' })
    );

  useEffect(() => {
    if (files.length === 0) return;
    getPageCount(files[0].rawBuffer)
      .then((count) => setTotalPages(count))
      .catch(() => setTotalPages(1));
  }, [files, getPageCount]);

  useEffect(() => {
    if (files.length === 0) return;
    let cancelled = false;
    loadDocument(files[0].rawBuffer)
      .then(async (doc) => {
        try {
          const page = await doc.getPage(pageIndex + 1);
          const viewport = page.getViewport({ scale: 1 });
          if (cancelled) return;
          setPageSizePt({ width: viewport.width, height: viewport.height });
          const preview = await renderPage(doc, pageIndex + 1, DISPLAY_WIDTH / viewport.width);
          if (!cancelled) setPageImage(preview.dataUrl);
        } finally {
          await memoryManager.destroyPdfDocument(doc);
        }
      })
      .catch(() => {
        if (!cancelled) setPageSizePt({ width: 595.28, height: 841.89 });
      });
    return () => {
      cancelled = true;
    };
  }, [files, pageIndex, loadDocument, renderPage]);

  const scalePxToPt = pageSizePt.width / DISPLAY_WIDTH;
  const displayHeight = DISPLAY_WIDTH * (pageSizePt.height / pageSizePt.width);

  const handleFilesAccepted = (accepted: PDFFile[]) => {
    setFiles(accepted.slice(0, 1));
    setElements([]);
    setResult(null);
    resetState();
  };

  const handleClearFiles = () => {
    setFiles([]);
    setElements([]);
    setResult(null);
    resetState();
  };

  const handleStageClick = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== containerRef.current) return; // clicked an element, not the page
    const rect = containerRef.current!.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const xPt = px * scalePxToPt;
    const yPt = pageSizePt.height - py * scalePxToPt;

    const id = `el_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newEl: EditorElement = {
      id,
      el: { type: 'text', pageIndex, xPt, yPt, text: 'New text', fontSize: 18, color: '#111827', bold: false },
    };
    setElements((prev) => [...prev, newEl]);
    setSelectedId(id);
    setResult(null);
  };

  const handleAddImageClick = () => imageInputRef.current?.click();

  const handleImageSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    const imageType = file.type === 'image/png' ? 'png' : file.type === 'image/jpeg' ? 'jpg' : null;
    if (!imageType) {
      alert('Only PNG and JPG images are supported.');
      return;
    }
    const bytes = await file.arrayBuffer();
    const previewUrl = URL.createObjectURL(file);
    memoryManager.registerUrl(previewUrl);
    const img = new Image();
    img.src = previewUrl;
    await new Promise((resolve) => (img.onload = resolve));
    const aspect = img.naturalWidth / img.naturalHeight;
    const widthPt = 150;
    const heightPt = widthPt / aspect;

    const id = `el_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    const newEl: EditorElement = {
      id,
      el: {
        type: 'image',
        pageIndex,
        xPt: (pageSizePt.width - widthPt) / 2,
        yPt: (pageSizePt.height - heightPt) / 2,
        widthPt,
        heightPt,
        imageBytes: bytes,
        imageType,
      },
      naturalAspect: aspect,
      previewUrl,
    };
    setElements((prev) => [...prev, newEl]);
    setSelectedId(id);
    setResult(null);
  };

  const updateSelected = (patch: Partial<EditElement>) => {
    setElements((prev) =>
      prev.map((e) => (e.id === selectedId ? { ...e, el: { ...e.el, ...patch } as EditElement } : e))
    );
  };

  const removeElement = (id: string) => {
    setElements((prev) => prev.filter((e) => e.id !== id));
    if (selectedId === id) setSelectedId(null);
  };

  const handleElementPointerDown = (e: React.PointerEvent, elId: string) => {
    e.stopPropagation();
    setSelectedId(elId);
    const target = elements.find((el) => el.id === elId);
    if (!target) return;
    dragRef.current = { id: elId, startPx: e.clientX, startPy: e.clientY, origXPt: target.el.xPt, origYPt: target.el.yPt };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handleElementPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { id, startPx, startPy, origXPt, origYPt } = dragRef.current;
    const deltaXPt = (e.clientX - startPx) * scalePxToPt;
    const deltaYPt = (e.clientY - startPy) * scalePxToPt;
    setElements((prev) =>
      prev.map((el) =>
        el.id === id ? { ...el, el: { ...el.el, xPt: origXPt + deltaXPt, yPt: origYPt - deltaYPt } as EditElement } : el
      )
    );
  };

  const handleElementPointerUp = () => {
    dragRef.current = null;
  };

  const executeEdit = async () => {
    if (files.length === 0 || elements.length === 0) return;
    const file = files[0];
    try {
      const bufferCopy = file.rawBuffer.slice(0);
      const elsCopy: EditElement[] = elements.map((e) =>
        e.el.type === 'image' ? { ...e.el, imageBytes: e.el.imageBytes.slice(0) } : { ...e.el }
      );
      const transferables = elsCopy
        .filter((e): e is Extract<EditElement, { type: 'image' }> => e.type === 'image')
        .map((e) => e.imageBytes);
      const payload: EditPdfPayload = { fileBuffer: bufferCopy, fileName: file.name, elements: elsCopy };
      const res = await runTask<EditPdfPayload>('EDIT_PDF', payload, [bufferCopy, ...transferables]);
      setResult(res);
    } catch (err) {
      console.error('Edit PDF error:', err);
    }
  };

  const handleDownload = () => {
    if (result) memoryManager.downloadBuffer(result.buffer, result.fileName);
  };

  const pageElements = elements.filter((e) => e.el.pageIndex === pageIndex);
  const selected = elements.find((e) => e.id === selectedId);

  return (
    <ToolLayout
      tool={TOOL_METADATA}
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
      resultFileName={result?.fileName || 'edited_document.pdf'}
      onDownloadResult={handleDownload}
      actionButtonLabel="Save Edits"
      onExecuteAction={executeEdit}
      canExecute={files.length > 0 && elements.length > 0}
    >
      {files.length === 0 ? (
        <Dropzone multiple={false} onFilesAccepted={handleFilesAccepted} title="Select a PDF to edit" subtitle="Add text and images anywhere on the page" />
      ) : (
        <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl p-6 shadow-sm space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-bold text-lg text-slate-900 dark:text-white">Click the page to add text</h3>
            <div className="flex items-center gap-2">
              <button
                onClick={handleAddImageClick}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-950/40 border border-amber-200 dark:border-amber-800 rounded-lg"
              >
                <ImagePlus className="w-3.5 h-3.5" />
                <span>Add Image</span>
              </button>
              <input ref={imageInputRef} type="file" accept="image/png,image/jpeg" className="hidden" onChange={handleImageSelected} />
              <select
                value={pageIndex}
                onChange={(e) => setPageIndex(parseInt(e.target.value, 10))}
                className="px-3 py-1.5 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-xs font-semibold text-slate-900 dark:text-white"
              >
                {Array.from({ length: totalPages }, (_, i) => (
                  <option key={i} value={i}>Page {i + 1}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="flex flex-col lg:flex-row gap-4">
            <div
              ref={containerRef}
              onClick={handleStageClick}
              onPointerMove={handleElementPointerMove}
              onPointerUp={handleElementPointerUp}
              className="relative bg-slate-100 dark:bg-slate-950 border border-slate-300 dark:border-slate-700 rounded-lg overflow-hidden cursor-text shrink-0"
              style={{ width: DISPLAY_WIDTH, height: displayHeight, backgroundImage: pageImage ? `url(${pageImage})` : undefined, backgroundSize: '100% 100%' }}
            >
              {pageElements.map((e) => {
                const leftPx = e.el.xPt / scalePxToPt;
                const isSelected = e.id === selectedId;
                if (e.el.type === 'text') {
                  const topPx = (pageSizePt.height - e.el.yPt) / scalePxToPt - e.el.fontSize / scalePxToPt;
                  return (
                    <div
                      key={e.id}
                      onPointerDown={(ev) => handleElementPointerDown(ev, e.id)}
                      className={`absolute px-1 cursor-move select-none whitespace-nowrap ${isSelected ? 'ring-2 ring-amber-500' : ''}`}
                      style={{
                        left: leftPx,
                        top: topPx,
                        fontSize: e.el.fontSize / scalePxToPt,
                        color: e.el.color,
                        fontWeight: e.el.bold ? 700 : 400,
                      }}
                    >
                      {e.el.text}
                    </div>
                  );
                }
                const topPx = (pageSizePt.height - e.el.yPt - e.el.heightPt) / scalePxToPt;
                return (
                  <img
                    key={e.id}
                    src={e.previewUrl}
                    onPointerDown={(ev) => handleElementPointerDown(ev, e.id)}
                    className={`absolute cursor-move select-none ${isSelected ? 'ring-2 ring-amber-500' : ''}`}
                    style={{ left: leftPx, top: topPx, width: e.el.widthPt / scalePxToPt, height: e.el.heightPt / scalePxToPt }}
                    draggable={false}
                  />
                );
              })}
            </div>

            <div className="flex-1 min-w-[200px] space-y-3">
              {!selected && (
                <p className="text-sm text-slate-500 dark:text-slate-400">
                  Click anywhere on the page to drop a text box, or use "Add Image". Drag elements to
                  reposition them; select one to edit its properties here.
                </p>
              )}

              {selected && selected.el.type === 'text' && (() => {
                const textEl = selected.el;
                return (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Text</label>
                    <input
                      type="text"
                      value={textEl.text}
                      onChange={(e) => updateSelected({ text: e.target.value })}
                      className="w-full px-3 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-300 dark:border-slate-700 rounded-lg text-sm text-slate-900 dark:text-white"
                    />
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex-1">
                      <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Size</label>
                      <input
                        type="range"
                        min={8}
                        max={72}
                        value={textEl.fontSize}
                        onChange={(e) => updateSelected({ fontSize: parseInt(e.target.value, 10) })}
                        className="w-full accent-amber-500"
                      />
                    </div>
                    <input
                      type="color"
                      value={textEl.color}
                      onChange={(e) => updateSelected({ color: e.target.value })}
                      className="w-9 h-9 rounded-md border border-slate-300 dark:border-slate-700"
                    />
                    <button
                      onClick={() => updateSelected({ bold: !textEl.bold })}
                      className={`p-2 rounded-md border ${textEl.bold ? 'bg-amber-100 dark:bg-amber-950 border-amber-400 text-amber-700' : 'border-slate-300 dark:border-slate-700 text-slate-500'}`}
                      title="Bold"
                    >
                      <Bold className="w-4 h-4" />
                    </button>
                  </div>
                  <button
                    onClick={() => removeElement(selected.id)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 hover:text-rose-700"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                </div>
                );
              })()}

              {selected && selected.el.type === 'image' && (
                <div className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold text-slate-600 dark:text-slate-400 mb-1">Width</label>
                    <input
                      type="range"
                      min={30}
                      max={pageSizePt.width}
                      value={selected.el.widthPt}
                      onChange={(e) => {
                        const w = parseInt(e.target.value, 10);
                        const aspect = selected.naturalAspect || 1;
                        updateSelected({ widthPt: w, heightPt: w / aspect });
                      }}
                      className="w-full accent-amber-500"
                    />
                  </div>
                  <button
                    onClick={() => removeElement(selected.id)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-rose-600 hover:text-rose-700"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>Delete</span>
                  </button>
                </div>
              )}

              {elements.length > 0 && (
                <div className="pt-3 border-t border-slate-100 dark:border-slate-800">
                  <p className="text-xs font-semibold text-slate-500 flex items-center gap-1.5">
                    <TypeIcon className="w-3.5 h-3.5" />
                    <span>{elements.length} element{elements.length === 1 ? '' : 's'} across all pages</span>
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </ToolLayout>
  );
};
