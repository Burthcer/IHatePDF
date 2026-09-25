/**
 * One page of the editor: the real rendered page (pdf.js output of the
 * edited PDF) with an interaction layer on top for selecting, moving,
 * resizing, drawing and typing.
 */

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { EditorBlockDTO, EditorPageAnalysis } from '../editPdf.worker';
import { cn } from '../../../components/ui';
import { blockRect, imageRect, normalizeRect, selectionRect, textRect, type Rect } from './geometry';
import {
  DEFAULT_TEXT_STYLE,
  cssFontFamily,
  imageKey,
  newId,
  type DocEdits,
  type EditStyle,
  type Selection,
  type Tool,
} from './types';

export interface PageCanvasProps {
  pageIndex: number;
  size: { width: number; height: number };
  zoom: number;
  canvas: HTMLCanvasElement | null;
  analysis: EditorPageAnalysis | null;
  edits: DocEdits;
  tool: Tool;
  selection: Selection;
  editing: Selection;
  /** True once the preview underneath no longer shows the object being edited. */
  cleanBackground: boolean;
  showBoxes: boolean;
  lastTextStyle: EditStyle;
  sampleColor: (x: number, y: number) => string;
  onSelect: (sel: Selection) => void;
  onStartEdit: (sel: Selection) => void;
  onFinishEdit: (text: string | null, heightPt?: number) => void;
  onCommit: (updater: (d: DocEdits) => DocEdits) => void;
  onRequestImage: (at: { x: number; y: number }) => void;
  onToolDone: () => void;
}

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

type Drag =
  | { type: 'move'; sel: NonNullable<Selection>; startX: number; startY: number; orig: Rect; dx: number; dy: number; moved: boolean }
  | { type: 'resize'; sel: NonNullable<Selection>; handle: Handle; startX: number; startY: number; orig: Rect; rect: Rect; keepAspect: boolean }
  | { type: 'draw'; tool: Tool; x0: number; y0: number; x1: number; y1: number };

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function CanvasHost({ canvas, width, height }: { canvas: HTMLCanvasElement | null; width: number; height: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.replaceChildren();
    if (canvas) {
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.style.display = 'block';
      host.appendChild(canvas);
    }
  }, [canvas, width, height]);
  return <div ref={ref} className="absolute inset-0 pointer-events-none" />;
}

function resizeRect(orig: Rect, handle: Handle, dx: number, dy: number, keepAspect: boolean): Rect {
  let { x, y, width, height } = orig;
  if (handle.includes('e')) width = orig.width + dx;
  if (handle.includes('s')) height = orig.height + dy;
  if (handle.includes('w')) {
    x = orig.x + dx;
    width = orig.width - dx;
  }
  if (handle.includes('n')) {
    y = orig.y + dy;
    height = orig.height - dy;
  }
  if (keepAspect && orig.width > 0 && orig.height > 0 && handle.length === 2) {
    const ratio = orig.width / orig.height;
    if (Math.abs(width / ratio) > Math.abs(height)) height = width / ratio;
    else width = height * ratio;
    if (handle.includes('n')) y = orig.y + orig.height - height;
    if (handle.includes('w')) x = orig.x + orig.width - width;
  }
  width = Math.max(4, width);
  height = Math.max(4, height);
  return { x, y, width, height };
}

// ------------------------------------------------------------ inline editor

function InlineEditor({
  initial,
  style,
  fontName,
  zoom,
  left,
  top,
  width,
  lineHeight,
  indent,
  background,
  onDone,
}: {
  initial: string;
  style: EditStyle;
  fontName?: string;
  zoom: number;
  left: number;
  top: number;
  width: number | null;
  lineHeight: number;
  indent: number;
  background: string | null;
  onDone: (text: string | null, heightPt?: number) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [value, setValue] = useState(initial);
  const done = useRef(false);

  const finish = (text: string | null) => {
    if (done.current) return;
    done.current = true;
    const h = ref.current ? ref.current.scrollHeight / zoom : undefined;
    onDone(text, h);
  };

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight}px`;
    if (width === null) {
      ta.style.width = '0px';
      ta.style.width = `${Math.max(40, ta.scrollWidth + 4)}px`;
    }
  }, [value, zoom, width, style.fontSize]);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }, []);

  const family = style.fontChoice === 'original' ? style.family : style.fontChoice;
  return (
    <textarea
      ref={ref}
      value={value}
      spellCheck
      wrap={width === null ? 'off' : 'soft'}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => finish(value)}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          finish(value);
        }
      }}
      className="absolute z-20 resize-none overflow-hidden border-0 p-0 m-0 outline outline-1 outline-accent outline-offset-2"
      style={{
        left: left * zoom,
        top: top * zoom,
        width: width === null ? undefined : width * zoom,
        fontSize: style.fontSize * zoom,
        lineHeight: `${lineHeight * zoom}px`,
        fontFamily: cssFontFamily(style.fontChoice === 'original' ? fontName : undefined, family),
        fontWeight: style.bold ? 700 : 400,
        fontStyle: style.italic ? 'italic' : 'normal',
        color: style.color,
        textAlign: style.align,
        textIndent: indent * zoom,
        background: background ?? 'transparent',
        boxShadow: background ? `0 0 0 ${3 * zoom}px ${background}` : undefined,
        whiteSpace: width === null ? 'pre' : 'pre-wrap',
        caretColor: 'rgb(var(--accent))',
      }}
    />
  );
}

// ------------------------------------------------------------------ page

export const PageCanvas: React.FC<PageCanvasProps> = (props) => {
  const {
    pageIndex,
    size,
    zoom,
    canvas,
    analysis,
    edits,
    tool,
    selection,
    editing,
    cleanBackground,
    showBoxes,
    lastTextStyle,
    sampleColor,
    onSelect,
    onStartEdit,
    onFinishEdit,
    onCommit,
    onRequestImage,
    onToolDone,
  } = props;
  const layerRef = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [hover, setHover] = useState<string | null>(null);

  const toPt = (e: { clientX: number; clientY: number }) => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / zoom, y: (e.clientY - r.top) / zoom };
  };

  const pageTexts = edits.texts.filter((t) => t.pageIndex === pageIndex);
  const pageAddedImages = edits.addedImages.filter((t) => t.pageIndex === pageIndex);
  const pageShapes = edits.shapes.filter((t) => t.pageIndex === pageIndex);

  // ---------------------------------------------------------- commit helpers
  const commitMove = (sel: NonNullable<Selection>, orig: Rect, dx: number, dy: number) => {
    onCommit((d) => {
      switch (sel.kind) {
        case 'block': {
          const prev = d.blocks[sel.id] ?? { id: sel.id, pageIndex };
          return { ...d, blocks: { ...d.blocks, [sel.id]: { ...prev, dx: (prev.dx ?? 0) + dx, dy: (prev.dy ?? 0) + dy } } };
        }
        case 'image': {
          const key = imageKey(pageIndex, sel.id);
          return { ...d, images: { ...d.images, [key]: { id: sel.id, pageIndex, box: { ...orig, x: orig.x + dx, y: orig.y + dy } } } };
        }
        case 'text':
          return { ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
        case 'addedImage':
          return { ...d, addedImages: d.addedImages.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
        case 'shape':
          return { ...d, shapes: d.shapes.map((t) => (t.id === sel.id ? { ...t, x: t.x + dx, y: t.y + dy } : t)) };
      }
    });
  };

  const commitResize = (sel: NonNullable<Selection>, r: Rect) => {
    onCommit((d) => {
      switch (sel.kind) {
        case 'block': {
          const block = analysis?.blocks.find((b) => b.id === sel.id);
          if (!block) return d;
          const prev = d.blocks[sel.id] ?? { id: sel.id, pageIndex };
          const pad = block.box.width - (block.frame.x1 - block.frame.x0);
          return { ...d, blocks: { ...d.blocks, [sel.id]: { ...prev, width: Math.max(10, r.width - pad), text: prev.text ?? block.text } } };
        }
        case 'image':
          return { ...d, images: { ...d.images, [imageKey(pageIndex, sel.id)]: { id: sel.id, pageIndex, box: r } } };
        case 'text':
          return { ...d, texts: d.texts.map((t) => (t.id === sel.id ? { ...t, x: r.x, width: Math.max(20, r.width) } : t)) };
        case 'addedImage':
          return { ...d, addedImages: d.addedImages.map((t) => (t.id === sel.id ? { ...t, ...r } : t)) };
        case 'shape':
          return {
            ...d,
            shapes: d.shapes.map((s) => (s.id === sel.id ? (s.kind === 'line' ? s : { ...s, ...r }) : s)),
          };
      }
    });
  };

  // ---------------------------------------------------------- pointer logic
  const startObjectDrag = (e: React.PointerEvent, sel: NonNullable<Selection>, rect: Rect) => {
    if (tool === 'highlight' && sel.kind === 'block') {
      e.stopPropagation();
      highlightBlock(sel.id);
      return;
    }
    if (tool !== 'select') return;
    e.stopPropagation();
    if (editing) return;
    onSelect(sel);
    const p = toPt(e);
    layerRef.current?.setPointerCapture(e.pointerId);
    setDrag({ type: 'move', sel, startX: p.x, startY: p.y, orig: rect, dx: 0, dy: 0, moved: false });
  };

  const startResize = (e: React.PointerEvent, sel: NonNullable<Selection>, handle: Handle, rect: Rect) => {
    e.stopPropagation();
    const p = toPt(e);
    layerRef.current?.setPointerCapture(e.pointerId);
    const keepAspect = sel.kind === 'image' || sel.kind === 'addedImage';
    setDrag({ type: 'resize', sel, handle, startX: p.x, startY: p.y, orig: rect, rect, keepAspect });
  };

  const highlightBlock = (id: string) => {
    const block = analysis?.blocks.find((b) => b.id === id);
    if (!block || block.angle !== 0) return;
    const e = edits.blocks[id];
    const dx = e?.dx ?? 0;
    const dy = e?.dy ?? 0;
    onCommit((d) => ({
      ...d,
      shapes: [
        ...d.shapes,
        ...block.lines.map((l) => ({
          id: newId('hl'),
          pageIndex,
          kind: 'highlight' as const,
          x: l.x0 + dx - 1,
          y: l.perp - block.frame.ascent * l.size + dy - 1,
          width: l.x1 - l.x0 + 2,
          height: (block.frame.ascent - block.frame.descent) * l.size + 2,
          fill: '#FFE066',
          stroke: null,
          strokeWidth: 0,
          opacity: 0.45,
        })),
      ],
    }));
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const p = toPt(e);
    if (editing) return; // blur commits the edit
    if (tool === 'select') {
      onSelect(null);
      return;
    }
    if (tool === 'text') {
      const id = newId('txt');
      const style = { ...DEFAULT_TEXT_STYLE, ...lastTextStyle, align: 'left' as const };
      onCommit((d) => ({
        ...d,
        texts: [...d.texts, { id, pageIndex, x: p.x, y: p.y - style.fontSize * 0.6, width: 0, text: '', style }],
      }));
      onSelect({ kind: 'text', id });
      onStartEdit({ kind: 'text', id });
      onToolDone();
      return;
    }
    if (tool === 'image') {
      onRequestImage(p);
      onToolDone();
      return;
    }
    layerRef.current?.setPointerCapture(e.pointerId);
    setDrag({ type: 'draw', tool, x0: p.x, y0: p.y, x1: p.x, y1: p.y });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const p = toPt(e);
    if (drag.type === 'move') {
      const dx = p.x - drag.startX;
      const dy = p.y - drag.startY;
      setDrag({ ...drag, dx, dy, moved: drag.moved || Math.hypot(dx, dy) * zoom > 3 });
    } else if (drag.type === 'resize') {
      setDrag({ ...drag, rect: resizeRect(drag.orig, drag.handle, p.x - drag.startX, p.y - drag.startY, drag.keepAspect && !e.shiftKey) });
    } else {
      setDrag({ ...drag, x1: p.x, y1: p.y });
    }
  };

  const onPointerUp = () => {
    if (!drag) return;
    const d = drag;
    setDrag(null);
    if (d.type === 'move') {
      if (d.moved) commitMove(d.sel, d.orig, d.dx, d.dy);
    } else if (d.type === 'resize') {
      commitResize(d.sel, d.rect);
    } else {
      let w = d.x1 - d.x0;
      let h = d.y1 - d.y0;
      const tiny = Math.abs(w) < 3 && Math.abs(h) < 3;
      if (d.tool === 'line') {
        if (tiny) w = 100;
      } else if (tiny) {
        w = d.tool === 'highlight' ? 120 : 100;
        h = d.tool === 'highlight' ? 16 : 60;
      }
      const rect = d.tool === 'line' ? { x: d.x0, y: d.y0, width: w, height: h } : normalizeRect({ x: d.x0, y: d.y0, width: w, height: h });
      const id = newId('shp');
      const kind = d.tool === 'whiteout' ? 'rect' : (d.tool as 'rect' | 'ellipse' | 'line' | 'highlight');
      const shape = {
        id,
        pageIndex,
        kind,
        ...rect,
        fill: d.tool === 'whiteout' ? sampleColor(rect.x + rect.width / 2, rect.y - 2) : d.tool === 'highlight' ? '#FFE066' : d.tool === 'line' ? null : null,
        stroke: d.tool === 'whiteout' || d.tool === 'highlight' ? null : '#D6341F',
        strokeWidth: d.tool === 'whiteout' ? 0 : 1.5,
        opacity: d.tool === 'highlight' ? 0.45 : 1,
      };
      onCommit((ed) => ({ ...ed, shapes: [...ed.shapes, shape] }));
      onSelect({ kind: 'shape', id });
      onToolDone();
    }
  };

  // ---------------------------------------------------------- geometry w/ drag
  const liveRect = (sel: NonNullable<Selection>, rect: Rect): Rect => {
    if (!drag || drag.type === 'draw') return rect;
    if (drag.sel.kind !== sel.kind || drag.sel.id !== sel.id) return rect;
    if (drag.type === 'move') return { ...rect, x: rect.x + drag.dx, y: rect.y + drag.dy };
    return drag.rect;
  };

  const isSelected = (sel: NonNullable<Selection>) => selection?.kind === sel.kind && selection.id === sel.id;
  const isEditing = (sel: NonNullable<Selection>) => editing?.kind === sel.kind && editing.id === sel.id;

  const W = size.width * zoom;
  const H = size.height * zoom;
  const cursor = tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair';

  const renderBlock = (b: EditorBlockDTO) => {
    const sel = { kind: 'block' as const, id: b.id };
    const edit = edits.blocks[b.id];
    if (edit?.deleted) return null;
    if (isEditing(sel)) return null;
    const r = liveRect(sel, blockRect(b, edits));
    const selected = isSelected(sel);
    const hovered = hover === b.id;
    const dragging = drag?.type !== 'draw' && drag?.sel.kind === 'block' && drag.sel.id === b.id;
    return (
      <div
        key={b.id}
        onPointerDown={(e) => startObjectDrag(e, sel, blockRect(b, edits))}
        onDoubleClick={(e) => {
          e.stopPropagation();
          if (tool === 'select' && b.editable) onStartEdit(sel);
        }}
        onPointerEnter={() => setHover(b.id)}
        onPointerLeave={() => setHover((h) => (h === b.id ? null : h))}
        className={cn(
          'absolute rounded-[1px]',
          tool === 'select' ? (b.editable ? 'cursor-text' : 'cursor-pointer') : tool === 'highlight' ? 'cursor-pointer' : 'pointer-events-none',
          (selected || dragging) && 'outline outline-[1.5px] outline-accent',
          !selected && hovered && tool !== 'text' && 'outline outline-1 outline-accent/60 bg-accent/5',
          !selected && !hovered && showBoxes && 'outline outline-1 outline-dashed outline-muted/40'
        )}
        style={{ left: (r.x - 1) * zoom, top: (r.y - 1) * zoom, width: (r.width + 2) * zoom, height: (r.height + 2) * zoom }}
        title={b.editable ? 'Double-click to edit' : b.reason}
      />
    );
  };

  const selRect = selection ? selectionRect(selection, analysis, edits, pageIndex) : null;
  const showHandles = selection && selRect && tool === 'select' && !editing;
  const handleSet: Handle[] =
    selection?.kind === 'block' || selection?.kind === 'text' ? ['e', 'w'] : HANDLES;
  const liveSel = showHandles ? liveRect(selection!, selRect!) : null;

  // ---------------------------------------------------------- inline editor
  let inlineEditor: React.ReactNode = null;
  if (editing?.kind === 'block' && analysis) {
    const b = analysis.blocks.find((x) => x.id === editing.id);
    if (b) {
      const e = edits.blocks[b.id];
      const style: EditStyle = { ...b.style, fontChoice: 'original', ...e?.style };
      const scale = style.fontSize / b.style.fontSize;
      const lineHeight = b.lines.length > 1 ? b.frame.lineHeight * scale : style.fontSize * 1.2;
      const baselineOffset = (lineHeight - 1.12 * style.fontSize) / 2 + 0.9 * style.fontSize;
      const width = e?.width ?? (b.frame.x1 - b.frame.x0) * scale;
      inlineEditor = (
        <InlineEditor
          key={b.id}
          initial={e?.text ?? b.text}
          style={style}
          fontName={b.fontName}
          zoom={zoom}
          left={b.frame.x0 + (e?.dx ?? 0)}
          top={b.frame.firstPerp + (e?.dy ?? 0) - baselineOffset}
          width={width + style.fontSize * 0.5}
          lineHeight={lineHeight}
          indent={style.align === 'left' ? b.frame.firstX - b.frame.x0 : 0}
          background={cleanBackground ? null : sampleColor(b.box.x - 1, b.box.y + b.box.height / 2)}
          onDone={onFinishEdit}
        />
      );
    }
  } else if (editing?.kind === 'text') {
    const t = pageTexts.find((x) => x.id === editing.id);
    if (t) {
      const lineHeight = t.style.fontSize * 1.25;
      inlineEditor = (
        <InlineEditor
          key={t.id}
          initial={t.text}
          style={t.style}
          zoom={zoom}
          left={t.x}
          top={t.y}
          width={t.width > 0 ? t.width : null}
          lineHeight={lineHeight}
          indent={0}
          background={null}
          onDone={onFinishEdit}
        />
      );
    }
  }

  return (
    <div className="relative bg-white shadow-page select-none" style={{ width: W, height: H }}>
      <CanvasHost canvas={canvas} width={W} height={H} />
      <div
        ref={layerRef}
        className="absolute inset-0"
        style={{ cursor }}
        onPointerDown={onBackgroundPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {analysis?.images.map((img) => {
          const sel = { kind: 'image' as const, id: img.id };
          const edit = edits.images[imageKey(pageIndex, img.id)];
          if (edit?.deleted) return null;
          const r = liveRect(sel, imageRect(img, edits, pageIndex));
          const selected = isSelected(sel);
          return (
            <div
              key={`img${img.id}`}
              onPointerDown={(e) => startObjectDrag(e, sel, imageRect(img, edits, pageIndex))}
              className={cn(
                'absolute',
                tool === 'select' ? 'cursor-move hover:outline hover:outline-1 hover:outline-accent/60' : 'pointer-events-none',
                selected && 'outline outline-[1.5px] outline-accent'
              )}
              style={{ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
            />
          );
        })}

        {analysis?.blocks.map(renderBlock)}

        {pageShapes.map((s) => {
          const sel = { kind: 'shape' as const, id: s.id };
          const base = normalizeRect({ x: s.x, y: s.y, width: s.width, height: s.height });
          const r = liveRect(sel, base);
          return (
            <div
              key={s.id}
              onPointerDown={(e) => startObjectDrag(e, sel, base)}
              className={cn('absolute', tool === 'select' ? 'cursor-move' : 'pointer-events-none', isSelected(sel) && 'outline outline-[1.5px] outline-accent')}
              style={{ left: r.x * zoom, top: r.y * zoom, width: Math.max(r.width, 4) * zoom, height: Math.max(r.height, 4) * zoom }}
            />
          );
        })}

        {pageAddedImages.map((im) => {
          const sel = { kind: 'addedImage' as const, id: im.id };
          const base = { x: im.x, y: im.y, width: im.width, height: im.height };
          const r = liveRect(sel, base);
          const moving = drag && drag.type !== 'draw' && drag.sel.id === im.id;
          return (
            <div
              key={im.id}
              onPointerDown={(e) => startObjectDrag(e, sel, base)}
              className={cn('absolute', tool === 'select' ? 'cursor-move' : 'pointer-events-none', isSelected(sel) && 'outline outline-[1.5px] outline-accent')}
              style={{ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
            >
              {moving && <img src={im.url} alt="" className="w-full h-full opacity-70" draggable={false} />}
            </div>
          );
        })}

        {pageTexts.map((t) => {
          const sel = { kind: 'text' as const, id: t.id };
          if (isEditing(sel)) return null;
          const base = textRect(t);
          const r = liveRect(sel, base);
          return (
            <div
              key={t.id}
              onPointerDown={(e) => startObjectDrag(e, sel, base)}
              onDoubleClick={(e) => {
                e.stopPropagation();
                if (tool === 'select') onStartEdit(sel);
              }}
              className={cn(
                'absolute',
                tool === 'select' ? 'cursor-text hover:outline hover:outline-1 hover:outline-accent/60' : 'pointer-events-none',
                isSelected(sel) && 'outline outline-[1.5px] outline-accent',
                showBoxes && !isSelected(sel) && 'outline outline-1 outline-dashed outline-muted/40'
              )}
              style={{ left: (r.x - 1) * zoom, top: (r.y - 1) * zoom, width: (r.width + 2) * zoom, height: (r.height + 2) * zoom }}
            />
          );
        })}

        {drag?.type === 'move' && drag.moved && (drag.sel.kind === 'block' || drag.sel.kind === 'image') && (
          <div
            className="absolute pointer-events-none border border-dashed border-accent bg-accent/5"
            style={{ left: (drag.orig.x + drag.dx) * zoom, top: (drag.orig.y + drag.dy) * zoom, width: drag.orig.width * zoom, height: drag.orig.height * zoom }}
          />
        )}

        {drag?.type === 'draw' && (() => {
          if (drag.tool === 'line') {
            const x = Math.min(drag.x0, drag.x1);
            const y = Math.min(drag.y0, drag.y1);
            return (
              <svg className="absolute pointer-events-none overflow-visible" style={{ left: 0, top: 0, width: W, height: H }}>
                <line x1={drag.x0 * zoom} y1={drag.y0 * zoom} x2={drag.x1 * zoom} y2={drag.y1 * zoom} stroke="#D6341F" strokeWidth={1.5 * zoom} data-x={x} data-y={y} />
              </svg>
            );
          }
          const r = normalizeRect({ x: drag.x0, y: drag.y0, width: drag.x1 - drag.x0, height: drag.y1 - drag.y0 });
          return (
            <div
              className={cn(
                'absolute pointer-events-none',
                drag.tool === 'whiteout' && 'bg-white border border-dashed border-muted',
                drag.tool === 'highlight' && 'bg-[#FFE066]/50',
                (drag.tool === 'rect' || drag.tool === 'ellipse') && 'border-[1.5px] border-[#D6341F]',
                drag.tool === 'ellipse' && 'rounded-[50%]'
              )}
              style={{ left: r.x * zoom, top: r.y * zoom, width: r.width * zoom, height: r.height * zoom }}
            />
          );
        })()}

        {showHandles && liveSel &&
          handleSet.map((h) => {
            const hx = h.includes('w') ? liveSel.x : h.includes('e') ? liveSel.x + liveSel.width : liveSel.x + liveSel.width / 2;
            const hy = h.includes('n') ? liveSel.y : h.includes('s') ? liveSel.y + liveSel.height : liveSel.y + liveSel.height / 2;
            return (
              <div
                key={h}
                onPointerDown={(e) => startResize(e, selection!, h, selRect!)}
                className="absolute z-10 w-2 h-2 -ml-1 -mt-1 bg-panel border border-accent"
                style={{ left: hx * zoom, top: hy * zoom, cursor: `${h}-resize` }}
              />
            );
          })}

        {inlineEditor}
      </div>
    </div>
  );
};
