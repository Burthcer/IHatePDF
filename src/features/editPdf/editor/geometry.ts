import type { EditorBlockDTO, EditorImageDTO, EditorPageAnalysis } from '../editPdf.worker';
import { cssFontFamily, imageKey, type DocEdits, type Selection } from './types';

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

let measureCtx: CanvasRenderingContext2D | null = null;
export function measureTextWidth(text: string, fontSizePt: number, family: 'sans' | 'serif' | 'mono', bold: boolean, italic: boolean, fontName?: string): number {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  if (!measureCtx) return text.length * fontSizePt * 0.5;
  measureCtx.font = `${italic ? 'italic ' : ''}${bold ? '700 ' : '400 '}${fontSizePt}px ${cssFontFamily(fontName, family)}`;
  return Math.max(...text.split('\n').map((l) => measureCtx!.measureText(l).width), 0);
}

export function blockRect(block: EditorBlockDTO, edits: DocEdits): Rect {
  const e = edits.blocks[block.id];
  const dx = e?.dx ?? 0;
  const dy = e?.dy ?? 0;
  const horizontal = block.angle === 0;
  let width = block.box.width;
  let height = block.box.height;
  if (e && horizontal) {
    if (e.width !== undefined) width = e.width + (block.box.width - (block.frame.x1 - block.frame.x0));
    if (e.uiHeight !== undefined) height = Math.max(e.uiHeight, block.style.fontSize);
  }
  return { x: block.box.x + dx, y: block.box.y + dy, width, height };
}

export function textRect(t: DocEdits['texts'][number]): Rect {
  const lines = Math.max(1, t.text.split('\n').length);
  const width =
    t.width > 0 ? t.width : Math.max(t.style.fontSize * 2, measureTextWidth(t.text || ' ', t.style.fontSize, t.style.family === 'serif' ? 'serif' : t.style.family === 'mono' ? 'mono' : 'sans', t.style.bold, t.style.italic));
  const wrappedLines = t.width > 0 ? Math.max(lines, Math.ceil(measureTextWidth(t.text, t.style.fontSize, 'sans', t.style.bold, t.style.italic) / t.width)) : lines;
  return { x: t.x, y: t.y, width, height: wrappedLines * t.style.fontSize * 1.25 };
}

export function imageRect(img: EditorImageDTO, edits: DocEdits, pageIndex: number): Rect {
  return edits.images[imageKey(pageIndex, img.id)]?.box ?? img.box;
}

export function selectionRect(sel: Selection, analysis: EditorPageAnalysis | null, edits: DocEdits, pageIndex: number): Rect | null {
  if (!sel) return null;
  switch (sel.kind) {
    case 'block': {
      const b = analysis?.blocks.find((x) => x.id === sel.id);
      return b ? blockRect(b, edits) : null;
    }
    case 'image': {
      const img = analysis?.images.find((x) => x.id === sel.id);
      return img ? imageRect(img, edits, pageIndex) : null;
    }
    case 'text': {
      const t = edits.texts.find((x) => x.id === sel.id);
      return t ? textRect(t) : null;
    }
    case 'addedImage': {
      const i = edits.addedImages.find((x) => x.id === sel.id);
      return i ? { x: i.x, y: i.y, width: i.width, height: i.height } : null;
    }
    case 'shape': {
      const s = edits.shapes.find((x) => x.id === sel.id);
      if (!s) return null;
      return normalizeRect({ x: s.x, y: s.y, width: s.width, height: s.height });
    }
  }
}

export function normalizeRect(r: Rect): Rect {
  return {
    x: r.width < 0 ? r.x + r.width : r.x,
    y: r.height < 0 ? r.y + r.height : r.y,
    width: Math.abs(r.width),
    height: Math.abs(r.height),
  };
}
