/**
 * Edit PDF — a page editor that changes the document itself:
 * retype existing paragraphs (reflowed, in the original font where
 * possible), move/resize/delete existing text and images, add text boxes,
 * images, shapes, highlights and whiteout. Every change is previewed by
 * rendering the actual edited PDF, so what you see is what you download.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Circle,
  Download,
  Eraser,
  Highlighter,
  ImagePlus,
  Minus,
  MousePointer2,
  Plus,
  Redo2,
  ScanText,
  Square,
  Type,
  Undo2,
} from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Dropzone } from '../../components/common/Dropzone';
import { Button, IconButton, Kbd, Notice, ProgressLine, Spinner, cn } from '../../components/ui';
import { openPdfJsDocument } from '../../services/pdfWorkerSetup';
import { memoryManager } from '../../services/memoryManager';
import { WorkerClient } from '../../services/workerClient';
import type { PDFFile } from '../../types/pdf';
import type { EditorPageAnalysis, EditorPageInfo } from './editPdf.worker';
import { PageCanvas } from './editor/PageCanvas';
import { Inspector } from './editor/Inspector';
import { selectionRect } from './editor/geometry';
import {
  DEFAULT_TEXT_STYLE,
  EMPTY_EDITS,
  editsForPage,
  imageKey,
  newId,
  pageEditCount,
  pageSignature,
  type DocEdits,
  type EditStyle,
  type Selection,
  type Tool,
} from './editor/types';

interface EditPdfViewProps {
  initialFiles?: PDFFile[];
  onBack: () => void;
}

interface History {
  past: DocEdits[];
  present: DocEdits;
  future: DocEdits[];
  lastKey?: string;
  lastTime: number;
}

const TOOLS: Array<{ id: Tool; label: string; key: string; icon: React.ReactNode }> = [
  { id: 'select', label: 'Select & edit', key: 'v', icon: <MousePointer2 className="w-4 h-4" /> },
  { id: 'text', label: 'Add text', key: 't', icon: <Type className="w-4 h-4" /> },
  { id: 'image', label: 'Add image', key: 'i', icon: <ImagePlus className="w-4 h-4" /> },
  { id: 'whiteout', label: 'Whiteout', key: 'w', icon: <Eraser className="w-4 h-4" /> },
  { id: 'rect', label: 'Rectangle', key: 'r', icon: <Square className="w-4 h-4" /> },
  { id: 'ellipse', label: 'Ellipse', key: 'e', icon: <Circle className="w-4 h-4" /> },
  { id: 'line', label: 'Line', key: 'l', icon: <Minus className="w-4 h-4 -rotate-45" /> },
  { id: 'highlight', label: 'Highlight', key: 'h', icon: <Highlighter className="w-4 h-4" /> },
];

function releaseCanvas(c: HTMLCanvasElement | null) {
  if (c) {
    c.width = 0;
    c.height = 0;
  }
}

async function renderPageCanvas(doc: PDFDocumentProxy, pageNumber: number, scale: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(viewport.width));
  canvas.height = Math.max(1, Math.floor(viewport.height));
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true })!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  page.cleanup();
  return canvas;
}

async function decodeImageFile(file: File): Promise<{ bytes: ArrayBuffer; type: 'png' | 'jpg'; width: number; height: number; url: string }> {
  const url = URL.createObjectURL(file);
  memoryManager.registerUrl(url);
  const img = new Image();
  img.src = url;
  await img.decode();
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (file.type === 'image/png' || file.type === 'image/jpeg') {
    return { bytes: await file.arrayBuffer(), type: file.type === 'image/png' ? 'png' : 'jpg', width, height, url };
  }
  // WebP, GIF, BMP, AVIF, SVG…: re-encode through a canvas as PNG.
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'));
  if (!blob) throw new Error('Could not read this image.');
  return { bytes: await blob.arrayBuffer(), type: 'png', width, height, url };
}

export const EditPdfView: React.FC<EditPdfViewProps> = ({ initialFiles = [], onBack }) => {
  const [file, setFile] = useState<PDFFile | null>(initialFiles[0] ?? null);
  const [pages, setPages] = useState<EditorPageInfo[]>([]);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [zoomMode, setZoomMode] = useState<'fit' | number>('fit');
  const [fitZoom, setFitZoom] = useState(1);
  const [analyses, setAnalyses] = useState<Record<number, EditorPageAnalysis>>({});
  const [history, setHistory] = useState<History>({ past: [], present: EMPTY_EDITS, future: [], lastTime: 0 });
  const [tool, setTool] = useState<Tool>('select');
  const [selection, setSelection] = useState<Selection>(null);
  const [editing, setEditing] = useState<Selection>(null);
  const [showBoxes, setShowBoxes] = useState(false);
  const [thumbs, setThumbs] = useState<string[]>([]);
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [renderedSig, setRenderedSig] = useState<string | null>(null);
  const [rendering, setRendering] = useState(false);
  const [exporting, setExporting] = useState<{ progress: number; stage: string } | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [lastTextStyle, setLastTextStyle] = useState<EditStyle>(DEFAULT_TEXT_STYLE);

  const clientRef = useRef<WorkerClient | null>(null);
  const originalDocRef = useRef<PDFDocumentProxy | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const pendingImageAt = useRef<{ x: number; y: number } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderToken = useRef(0);

  const edits = history.present;
  const zoom = zoomMode === 'fit' ? fitZoom : zoomMode;
  const pageSize = pages[pageIndex];
  const analysis = analyses[pageIndex] ?? null;

  // ------------------------------------------------------------- session
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    const client = new WorkerClient(() => new Worker(new URL('./editPdf.worker.ts', import.meta.url), { type: 'module' }));
    clientRef.current = client;
    setPages([]);
    setAnalyses({});
    setThumbs([]);
    setOpenError(null);
    setHistory({ past: [], present: EMPTY_EDITS, future: [], lastTime: 0 });
    setSelection(null);
    setEditing(null);
    setPageIndex(0);

    (async () => {
      try {
        const buffer = file.rawBuffer.slice(0);
        const [{ pages: info }, doc] = await Promise.all([
          client.call<{ pages: EditorPageInfo[] }>('OPEN', { buffer }, [buffer]),
          openPdfJsDocument(file.rawBuffer).promise,
        ]);
        if (cancelled) {
          void memoryManager.destroyPdfDocument(doc);
          return;
        }
        originalDocRef.current = doc;
        setPages(info);
        // thumbnails, in the background
        for (let i = 0; i < doc.numPages && !cancelled; i++) {
          const page = await doc.getPage(i + 1);
          const vp = page.getViewport({ scale: 1 });
          const c = await renderPageCanvas(doc, i + 1, 128 / vp.width);
          const url = c.toDataURL('image/jpeg', 0.7);
          releaseCanvas(c);
          if (cancelled) break;
          setThumbs((prev) => {
            const next = prev.slice();
            next[i] = url;
            return next;
          });
        }
      } catch (err) {
        if (!cancelled) setOpenError(err instanceof Error ? err.message : String(err));
      }
    })();

    return () => {
      cancelled = true;
      client.terminate();
      clientRef.current = null;
      void memoryManager.destroyPdfDocument(originalDocRef.current);
      originalDocRef.current = null;
    };
  }, [file]);

  // ------------------------------------------------------------- fit zoom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !pageSize) return;
    const update = () => {
      const avail = el.clientWidth - 64;
      setFitZoom(Math.max(0.25, Math.min(2.5, avail / pageSize.width)));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pageSize]);

  // ------------------------------------------------------------- analysis
  useEffect(() => {
    const client = clientRef.current;
    if (!client || !pages.length || analyses[pageIndex]) return;
    let cancelled = false;
    client
      .call<EditorPageAnalysis>('ANALYZE', { pageIndex })
      .then((a) => !cancelled && setAnalyses((prev) => ({ ...prev, [pageIndex]: a })))
      .catch((err) => console.warn('Analysis failed', err));
    return () => {
      cancelled = true;
    };
  }, [pageIndex, pages, analyses]);

  // ------------------------------------------------------------- rendering
  // While an object is being typed into, the preview omits it so the text
  // underneath is genuinely gone and the typing happens on a clean page.
  const previewEdits = useMemo<DocEdits>(() => {
    if (!editing) return edits;
    if (editing.kind === 'block') {
      const prev = edits.blocks[editing.id] ?? { id: editing.id, pageIndex };
      return { ...edits, blocks: { ...edits.blocks, [editing.id]: { ...prev, deleted: true } } };
    }
    if (editing.kind === 'text') return { ...edits, texts: edits.texts.filter((t) => t.id !== editing.id) };
    return edits;
  }, [edits, editing, pageIndex]);

  const signature = useMemo(() => `${pageIndex}|${zoom.toFixed(3)}|${pageSignature(previewEdits, pageIndex)}`, [previewEdits, pageIndex, zoom]);
  const hasPageEdits = pageEditCount(previewEdits, pageIndex) > 0;

  useEffect(() => {
    const client = clientRef.current;
    const original = originalDocRef.current;
    if (!client || !original || !pageSize) return;
    const token = ++renderToken.current;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const scale = zoom * dpr;
    setRendering(true);
    const timer = window.setTimeout(
      async () => {
        try {
          let next: HTMLCanvasElement;
          if (!hasPageEdits) {
            next = await renderPageCanvas(original, pageIndex + 1, scale);
          } else {
            const { buffer } = await client.call<{ buffer: ArrayBuffer }>('PREVIEW', { edits: editsForPage(previewEdits, pageIndex) });
            const doc = await openPdfJsDocument(buffer).promise;
            try {
              next = await renderPageCanvas(doc, 1, scale);
            } finally {
              void memoryManager.destroyPdfDocument(doc);
            }
          }
          if (token !== renderToken.current) {
            releaseCanvas(next);
            return;
          }
          const prev = canvasRef.current;
          canvasRef.current = next;
          setCanvas(next);
          setRenderedSig(signature);
          setRendering(false);
          if (prev && prev !== next) window.setTimeout(() => releaseCanvas(prev), 0);
        } catch (err) {
          if (token === renderToken.current) {
            setRendering(false);
            console.error('Preview failed', err);
            setExportError(`Preview failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
      hasPageEdits ? 120 : 0
    );
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, pages]);

  useEffect(() => () => releaseCanvas(canvasRef.current), []);

  const sampleColor = useCallback(
    (x: number, y: number) => {
      const c = canvasRef.current;
      const ctx = c?.getContext('2d', { willReadFrequently: true });
      if (!c || !ctx) return '#ffffff';
      const k = c.width / ((pageSize?.width ?? 1) || 1);
      const px = Math.min(c.width - 1, Math.max(0, Math.round(x * k)));
      const py = Math.min(c.height - 1, Math.max(0, Math.round(y * k)));
      const d = ctx.getImageData(px, py, 1, 1).data;
      return '#' + [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    },
    [pageSize]
  );

  // ------------------------------------------------------------- history
  const commit = useCallback((updater: (d: DocEdits) => DocEdits, coalesceKey?: string) => {
    setHistory((h) => {
      const next = updater(h.present);
      if (next === h.present) return h;
      const now = Date.now();
      if (coalesceKey && h.lastKey === coalesceKey && now - h.lastTime < 1500) {
        return { ...h, present: next, future: [], lastTime: now };
      }
      return { past: [...h.past.slice(-200), h.present], present: next, future: [], lastKey: coalesceKey, lastTime: now };
    });
  }, []);

  const undo = useCallback(() => {
    setEditing(null);
    setHistory((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future], lastTime: 0 } : h));
  }, []);
  const redo = useCallback(() => {
    setEditing(null);
    setHistory((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1), lastTime: 0 } : h));
  }, []);

  // ------------------------------------------------------------- actions
  const finishEdit = useCallback(
    (text: string | null, heightPt?: number) => {
      const target = editing;
      setEditing(null);
      if (!target || text === null) {
        // Cancelled: drop a brand-new empty text box.
        if (target?.kind === 'text') commit((d) => ({ ...d, texts: d.texts.filter((t) => t.id !== target.id || t.text.trim() !== '') }));
        return;
      }
      if (target.kind === 'block') {
        const block = analyses[pageIndex]?.blocks.find((b) => b.id === target.id);
        if (!block) return;
        commit((d) => {
          const prev = d.blocks[target.id];
          const current = prev?.text ?? block.text;
          if (text === current) return d;
          return { ...d, blocks: { ...d.blocks, [target.id]: { ...(prev ?? { id: target.id, pageIndex }), text, uiHeight: heightPt } } };
        });
      } else if (target.kind === 'text') {
        commit((d) =>
          text.trim() === ''
            ? { ...d, texts: d.texts.filter((t) => t.id !== target.id) }
            : { ...d, texts: d.texts.map((t) => (t.id === target.id ? { ...t, text } : t)) }
        );
        if (text.trim() === '') setSelection(null);
      }
    },
    [editing, analyses, pageIndex, commit]
  );

  const deleteSelection = useCallback(() => {
    const sel = selection;
    if (!sel) return;
    commit((d) => {
      switch (sel.kind) {
        case 'block':
          return { ...d, blocks: { ...d.blocks, [sel.id]: { ...(d.blocks[sel.id] ?? { id: sel.id, pageIndex }), deleted: true } } };
        case 'image':
          return { ...d, images: { ...d.images, [imageKey(pageIndex, sel.id)]: { id: sel.id, pageIndex, deleted: true } } };
        case 'text':
          return { ...d, texts: d.texts.filter((t) => t.id !== sel.id) };
        case 'addedImage':
          return { ...d, addedImages: d.addedImages.filter((t) => t.id !== sel.id) };
        case 'shape':
          return { ...d, shapes: d.shapes.filter((t) => t.id !== sel.id) };
      }
    });
    setSelection(null);
  }, [selection, commit, pageIndex]);

  const nudge = useCallback(
    (dx: number, dy: number) => {
      const sel = selection;
      if (!sel) return;
      const rect = selectionRect(sel, analysis, edits, pageIndex);
      if (!rect) return;
      commit((d) => {
        switch (sel.kind) {
          case 'block': {
            const prev = d.blocks[sel.id] ?? { id: sel.id, pageIndex };
            return { ...d, blocks: { ...d.blocks, [sel.id]: { ...prev, dx: (prev.dx ?? 0) + dx, dy: (prev.dy ?? 0) + dy } } };
          }
          case 'image':
            return { ...d, images: { ...d.images, [imageKey(pageIndex, sel.id)]: { id: sel.id, pageIndex, box: { ...rect, x: rect.x + dx, y: rect.y + dy } } } };
          case 'text':
            return { ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
          case 'addedImage':
            return { ...d, addedImages: d.addedImages.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
          case 'shape':
            return { ...d, shapes: d.shapes.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
        }
      }, `nudge:${sel.kind}:${sel.id}`);
    },
    [selection, analysis, edits, pageIndex, commit]
  );

  const goToPage = useCallback(
    (i: number) => {
      if (i < 0 || i >= pages.length) return;
      setEditing(null);
      setSelection(null);
      setPageIndex(i);
      scrollRef.current?.scrollTo({ top: 0 });
    },
    [pages.length]
  );

  const handleImageChosen = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f || !pageSize) return;
    try {
      const img = await decodeImageFile(f);
      const maxW = pageSize.width * 0.4;
      const scale = Math.min(1, maxW / img.width, (pageSize.height * 0.4) / img.height);
      const width = img.width * scale;
      const height = img.height * scale;
      const at = pendingImageAt.current ?? { x: (pageSize.width - width) / 2, y: (pageSize.height - height) / 2 };
      pendingImageAt.current = null;
      const id = newId('img');
      commit((d) => ({
        ...d,
        addedImages: [
          ...d.addedImages,
          { id, pageIndex, x: Math.min(at.x, pageSize.width - width), y: Math.min(at.y, pageSize.height - height), width, height, bytes: img.bytes, type: img.type, url: img.url },
        ],
      }));
      setSelection({ kind: 'addedImage', id });
    } catch (err) {
      setExportError(err instanceof Error ? err.message : 'Could not read this image.');
    }
  };

  const exportPdf = async () => {
    const client = clientRef.current;
    if (!client || !file) return;
    setEditing(null);
    setExportError(null);
    setExporting({ progress: 0, stage: 'Preparing…' });
    try {
      const pageIndices = new Set<number>();
      Object.values(edits.blocks).forEach((b) => pageIndices.add(b.pageIndex));
      Object.values(edits.images).forEach((b) => pageIndices.add(b.pageIndex));
      [...edits.texts, ...edits.addedImages, ...edits.shapes].forEach((b) => pageIndices.add(b.pageIndex));
      const all = [...pageIndices].sort((a, b) => a - b).map((i) => editsForPage(edits, i));
      const result = await client.call<{ fileName: string; buffer: ArrayBuffer }>('EXPORT', { edits: all, fileName: file.name }, [], (progress, stage) =>
        setExporting({ progress, stage })
      );
      memoryManager.downloadBuffer(result.buffer, result.fileName);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : String(err));
    } finally {
      setExporting(null);
    }
  };

  // ------------------------------------------------------------- keyboard
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable="true"]')) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if (mod) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selection) {
          e.preventDefault();
          deleteSelection();
        }
        return;
      }
      if (e.key === 'Escape') {
        setSelection(null);
        setTool('select');
        return;
      }
      if (e.key === 'Enter' && selection && (selection.kind === 'block' || selection.kind === 'text')) {
        e.preventDefault();
        setEditing(selection);
        return;
      }
      if (e.key.startsWith('Arrow') && selection) {
        e.preventDefault();
        const step = e.shiftKey ? 10 : 1;
        nudge(e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0, e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0);
        return;
      }
      if (e.key === 'PageDown') return goToPage(pageIndex + 1);
      if (e.key === 'PageUp') return goToPage(pageIndex - 1);
      const t = TOOLS.find((x) => x.key === e.key.toLowerCase());
      if (t) {
        setTool(t.id);
        if (t.id === 'image') {
          pendingImageAt.current = null;
          imageInputRef.current?.click();
          setTool('select');
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selection, deleteSelection, undo, redo, nudge, goToPage, pageIndex]);

  // ------------------------------------------------------------- render
  if (!file) {
    return (
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-6">
        <button onClick={onBack} className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-ink">
          <ArrowLeft className="w-3.5 h-3.5" /> All tools
        </button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Edit PDF</h1>
          <p className="text-muted mt-1">
            Change the text that’s already in the document — typos, numbers, whole paragraphs — plus add text, images,
            shapes and highlights.
          </p>
        </div>
        <Dropzone multiple={false} onFilesAccepted={(f) => setFile(f[0])} title="Choose a PDF to edit" />
      </div>
    );
  }

  const totalEdits =
    Object.keys(edits.blocks).length + Object.keys(edits.images).length + edits.texts.length + edits.addedImages.length + edits.shapes.length;

  return (
    <div className="flex flex-col h-[calc(100vh-3rem)] min-h-[520px]">
      {/* toolbar */}
      <div className="flex items-center gap-2 h-12 px-3 border-b border-line bg-panel shrink-0 overflow-x-auto scroll-thin">
        <IconButton label="Back to all tools" onClick={onBack}>
          <ArrowLeft className="w-4 h-4" />
        </IconButton>
        <div className="min-w-0 max-w-[220px] hidden md:block">
          <p className="text-sm font-medium truncate" title={file.name}>
            {file.name}
          </p>
          <p className="font-mono text-2xs text-muted">{totalEdits ? `${totalEdits} change${totalEdits === 1 ? '' : 's'}` : 'No changes yet'}</p>
        </div>
        <div className="w-px h-6 bg-line mx-1 hidden md:block" />
        <div className="flex items-center gap-0.5">
          {TOOLS.map((t) => (
            <IconButton
              key={t.id}
              label={`${t.label} (${t.key.toUpperCase()})`}
              active={tool === t.id}
              onClick={() => {
                if (t.id === 'image') {
                  pendingImageAt.current = null;
                  imageInputRef.current?.click();
                  return;
                }
                setTool(t.id);
              }}
            >
              {t.icon}
            </IconButton>
          ))}
        </div>
        <div className="w-px h-6 bg-line mx-1" />
        <IconButton label="Undo (⌘Z)" onClick={undo} disabled={!history.past.length}>
          <Undo2 className="w-4 h-4" />
        </IconButton>
        <IconButton label="Redo (⇧⌘Z)" onClick={redo} disabled={!history.future.length}>
          <Redo2 className="w-4 h-4" />
        </IconButton>
        <IconButton label="Show text boxes" active={showBoxes} onClick={() => setShowBoxes((v) => !v)}>
          <ScanText className="w-4 h-4" />
        </IconButton>
        <div className="flex-1" />
        <div className="flex items-center gap-1">
          <IconButton label="Zoom out" size="sm" onClick={() => setZoomMode(Math.max(0.25, +(zoom / 1.2).toFixed(2)))}>
            <Minus className="w-3.5 h-3.5" />
          </IconButton>
          <button
            className="font-mono text-2xs w-12 h-7 rounded hover:bg-hover tabular-nums"
            onClick={() => setZoomMode('fit')}
            title="Fit to width"
          >
            {Math.round(zoom * 100)}%
          </button>
          <IconButton label="Zoom in" size="sm" onClick={() => setZoomMode(Math.min(4, +(zoom * 1.2).toFixed(2)))}>
            <Plus className="w-3.5 h-3.5" />
          </IconButton>
        </div>
        <div className="w-px h-6 bg-line mx-1" />
        <Button variant="primary" icon={<Download className="w-4 h-4" />} onClick={exportPdf} loading={!!exporting} disabled={!pages.length}>
          Download
        </Button>
        <input ref={imageInputRef} type="file" accept="image/*" className="hidden" onChange={handleImageChosen} />
      </div>

      <div className="flex flex-1 min-h-0">
        {/* thumbnails */}
        <aside className="hidden md:flex flex-col w-[152px] shrink-0 border-r border-line bg-panel overflow-y-auto scroll-thin py-3 gap-3 items-center">
          {pages.map((p, i) => {
            const count = pageEditCount(edits, i);
            return (
              <button
                key={i}
                onClick={() => goToPage(i)}
                className={cn('group flex flex-col items-center gap-1 px-2', i === pageIndex ? 'text-ink' : 'text-muted hover:text-ink')}
              >
                <div
                  className={cn('relative bg-white border', i === pageIndex ? 'border-accent outline outline-1 outline-accent' : 'border-line group-hover:border-line-strong')}
                  style={{ width: 112, height: (112 * p.height) / p.width }}
                >
                  {thumbs[i] && <img src={thumbs[i]} alt="" className="w-full h-full object-contain" />}
                  {count > 0 && <span className="absolute -top-1.5 -right-1.5 min-w-4 h-4 px-1 rounded-full bg-accent text-accent-ink font-mono text-[10px] leading-4 text-center">{count}</span>}
                </div>
                <span className="font-mono text-2xs">{i + 1}</span>
              </button>
            );
          })}
        </aside>

        {/* page */}
        <main ref={scrollRef} className="relative flex-1 min-w-0 overflow-auto bg-sunken scroll-thin">
          {openError ? (
            <div className="max-w-md mx-auto mt-16">
              <Notice tone="error" title="This PDF couldn’t be opened for editing">
                {openError}
              </Notice>
            </div>
          ) : !pageSize ? (
            <div className="flex items-center justify-center h-full gap-2 text-muted text-sm">
              <Spinner /> Reading document…
            </div>
          ) : (
            <div className="min-w-fit flex flex-col items-center px-8 py-8">
              <PageCanvas
                pageIndex={pageIndex}
                size={pageSize}
                zoom={zoom}
                canvas={canvas}
                analysis={analysis}
                edits={edits}
                tool={tool}
                selection={selection}
                editing={editing}
                cleanBackground={renderedSig === signature}
                showBoxes={showBoxes}
                lastTextStyle={lastTextStyle}
                sampleColor={sampleColor}
                onSelect={setSelection}
                onStartEdit={(sel) => {
                  setSelection(sel);
                  setEditing(sel);
                }}
                onFinishEdit={finishEdit}
                onCommit={commit}
                onRequestImage={(at) => {
                  pendingImageAt.current = at;
                  imageInputRef.current?.click();
                }}
                onToolDone={() => setTool('select')}
              />
              <div className="flex items-center gap-3 mt-4 text-xs text-muted">
                <Button size="sm" variant="ghost" disabled={pageIndex === 0} onClick={() => goToPage(pageIndex - 1)}>
                  Previous
                </Button>
                <span className="font-mono text-2xs">
                  Page {pageIndex + 1} / {pages.length}
                </span>
                <Button size="sm" variant="ghost" disabled={pageIndex >= pages.length - 1} onClick={() => goToPage(pageIndex + 1)}>
                  Next
                </Button>
                {(rendering || !analysis) && <Spinner className="w-3.5 h-3.5" />}
              </div>
            </div>
          )}
        </main>

        {/* inspector */}
        <aside className="hidden lg:block w-[280px] shrink-0 border-l border-line bg-panel overflow-y-auto scroll-thin">
          {exporting && (
            <div className="p-4 border-b border-line">
              <ProgressLine progress={exporting.progress} stage={exporting.stage} />
            </div>
          )}
          {exportError && (
            <div className="p-4 border-b border-line">
              <Notice tone="error" title="Something went wrong">
                {exportError}
              </Notice>
            </div>
          )}
          <Inspector
            pageIndex={pageIndex}
            analysis={analysis}
            edits={edits}
            selection={selection}
            onCommit={commit}
            onDelete={deleteSelection}
            onStartEdit={(sel) => setEditing(sel)}
            onStyleUsed={(s) => setLastTextStyle({ ...s, fontChoice: s.fontChoice === 'original' ? s.family : s.fontChoice })}
          />
          <div className="px-4 pb-4 text-2xs text-faint font-mono flex flex-wrap gap-1 items-center">
            <Kbd>Dbl-click</Kbd> edit text
          </div>
        </aside>
      </div>
    </div>
  );
};
