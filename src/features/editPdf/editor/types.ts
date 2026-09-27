import type { AddedImage, AddedShape, AddedText, BlockEdit, EditStyle, ImageEdit, PageEdits, ShapeKind } from '../engine/rewrite';

export type { AddedImage, AddedShape, AddedText, BlockEdit, EditStyle, ImageEdit, PageEdits, ShapeKind };

export type Tool = 'select' | 'text' | 'image' | 'whiteout' | 'rect' | 'ellipse' | 'line' | 'highlight';

export type Paged<T> = T & { pageIndex: number };

/** Everything the user changed, across the whole document. Immutable snapshots feed undo/redo. */
export interface DocEdits {
  blocks: Record<string, Paged<BlockEdit> & { uiHeight?: number }>;
  images: Record<string, Paged<ImageEdit>>;
  texts: Array<Paged<AddedText>>;
  addedImages: Array<Paged<AddedImage> & { url: string }>;
  shapes: Array<Paged<AddedShape>>;
}

export const EMPTY_EDITS: DocEdits = { blocks: {}, images: {}, texts: [], addedImages: [], shapes: [] };

export type Selection =
  | { kind: 'block'; id: string }
  | { kind: 'image'; id: number }
  | { kind: 'text'; id: string }
  | { kind: 'addedImage'; id: string }
  | { kind: 'shape'; id: string }
  | null;

export function imageKey(pageIndex: number, id: number): string {
  return `${pageIndex}:${id}`;
}

export function editsForPage(edits: DocEdits, pageIndex: number): PageEdits {
  const strip = <T extends { pageIndex: number }>(o: T) => {
    const { pageIndex: _p, ...rest } = o;
    void _p;
    return rest;
  };
  return {
    pageIndex,
    blocks: Object.values(edits.blocks)
      .filter((b) => b.pageIndex === pageIndex)
      .map((b) => {
        const { uiHeight: _h, ...rest } = strip(b);
        void _h;
        return rest;
      }),
    images: Object.values(edits.images).filter((i) => i.pageIndex === pageIndex).map(strip),
    texts: edits.texts.filter((t) => t.pageIndex === pageIndex).map(strip),
    addedImages: edits.addedImages
      .filter((i) => i.pageIndex === pageIndex)
      .map((i) => {
        const { url: _u, ...rest } = strip(i);
        void _u;
        return rest;
      }),
    shapes: edits.shapes.filter((s) => s.pageIndex === pageIndex).map(strip),
  };
}

export function pageEditCount(edits: DocEdits, pageIndex: number): number {
  return (
    Object.values(edits.blocks).filter((b) => b.pageIndex === pageIndex).length +
    Object.values(edits.images).filter((b) => b.pageIndex === pageIndex).length +
    edits.texts.filter((b) => b.pageIndex === pageIndex).length +
    edits.addedImages.filter((b) => b.pageIndex === pageIndex).length +
    edits.shapes.filter((b) => b.pageIndex === pageIndex).length
  );
}

/** Stable signature of a page's edits (image bytes represented by id) for render caching. */
export function pageSignature(edits: DocEdits, pageIndex: number): string {
  const p = editsForPage(edits, pageIndex);
  return JSON.stringify({ ...p, addedImages: p.addedImages.map((i) => ({ ...i, bytes: i.id })) });
}

export function cssFontFamily(fontName: string | undefined, family: 'sans' | 'serif' | 'mono'): string {
  const generic =
    family === 'serif'
      ? '"Times New Roman", Times, Georgia, serif'
      : family === 'mono'
        ? '"Courier New", Courier, monospace'
        : 'Arial, Helvetica, "Liberation Sans", sans-serif';
  if (!fontName) return generic;
  const base = fontName
    .split(/[-,+]/)[0]
    .replace(/(MT|PS|Std|Pro)$/, '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim();
  return base ? `"${base}", ${generic}` : generic;
}

export const DEFAULT_TEXT_STYLE: EditStyle = {
  fontSize: 12,
  color: '#111111',
  bold: false,
  italic: false,
  family: 'sans',
  align: 'left',
  fontChoice: 'sans',
};

export function newId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}
