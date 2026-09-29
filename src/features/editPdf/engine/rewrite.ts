/**
 * Applies editor changes to a page for real — no white boxes painted over
 * old text:
 *
 *  - Edited/deleted/moved paragraphs: their glyphs are removed from the
 *    content stream (each removed glyph becomes an equal TJ displacement, so
 *    everything else on the line stays exactly where it was), and the new
 *    text is typeset in the original font when it has every character
 *    needed, otherwise in the closest standard/Unicode font.
 *  - Existing images: deleted (their `Do`/inline image op dropped) or
 *    moved/resized (wrapped in a compensating `cm`).
 *  - Form XObjects that need changes are cloned per use, so a header shared
 *    by every page isn't edited everywhere by accident.
 *  - New text boxes, images, shapes, highlights are drawn on top.
 */

import { PDFDict, PDFName, PDFRawStream, PDFStream, type PDFContext, type PDFDocument, type PDFFont, type PDFPage, type PDFRef } from 'pdf-lib';
import { GlyphRun, faceFor as scriptOf, fontForText, graphemes, needsShaping, standardFont, type FontFamily } from '../../../services/fonts';
import { formatHex, formatName, formatNumber, latin1 } from './lexer';
import { apply, applyVector, invert, multiply, type Matrix } from './geometry';
import { interpretPage, type GlyphInfo, type PageModel, type TextOpInfo } from './interpreter';
import { buildBlocks, type TextAlign, type TextBlock, type TextStyle } from './layout';
import type { FontModel } from './fontModel';
import { asRef } from './pdfObjects';

export type FamilyChoice = FontFamily | 'original';

export interface EditStyle extends TextStyle {
  /** 'original' keeps the document's own font when possible. */
  fontChoice: FamilyChoice;
}

export interface BlockEdit {
  id: string;
  text?: string;
  style?: Partial<EditStyle>;
  dx?: number;
  dy?: number;
  /** New wrap width (viewer points). */
  width?: number;
  deleted?: boolean;
}

export interface ImageEdit {
  id: number;
  deleted?: boolean;
  box?: { x: number; y: number; width: number; height: number };
}

export interface AddedText {
  id: string;
  x: number;
  y: number;
  width: number;
  text: string;
  style: EditStyle;
}

export interface AddedImage {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  bytes: ArrayBuffer;
  type: 'png' | 'jpg';
}

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'highlight';

export interface AddedShape {
  id: string;
  kind: ShapeKind;
  x: number;
  y: number;
  width: number;
  height: number;
  fill: string | null;
  stroke: string | null;
  strokeWidth: number;
  opacity: number;
}

export interface PageEdits {
  pageIndex: number;
  blocks: BlockEdit[];
  images: ImageEdit[];
  texts: AddedText[];
  addedImages: AddedImage[];
  shapes: AddedShape[];
}

export function pageHasEdits(e: PageEdits | undefined): boolean {
  return !!e && e.blocks.length + e.images.length + e.texts.length + e.addedImages.length + e.shapes.length > 0;
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean.padEnd(6, '0');
  const n = parseInt(full.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function rgbOps(hex: string, stroke = false): string {
  const [r, g, b] = hexToRgb(hex);
  return `${formatNumber(r)} ${formatNumber(g)} ${formatNumber(b)} ${stroke ? 'RG' : 'rg'}`;
}

/** Resource names added to a context's /Resources, per category. */
type ResourceAdds = Map<'Font' | 'XObject' | 'ExtGState', Map<string, PDFRef>>;

class ResourceNamer {
  private used = new Set<string>();
  private n = 0;
  constructor(existing: PDFDict | undefined) {
    if (!existing) return;
    for (const cat of ['Font', 'XObject', 'ExtGState']) {
      const sub = existing.lookup(PDFName.of(cat));
      if (sub instanceof PDFDict) sub.keys().forEach((k) => this.used.add(k.decodeText()));
    }
  }
  next(prefix: string): string {
    let name: string;
    do name = `${prefix}${++this.n}`;
    while (this.used.has(name));
    this.used.add(name);
    return name;
  }
}

function cloneResources(context: PDFContext, base: PDFDict | undefined, adds: ResourceAdds): PDFDict {
  const res = base ? base.clone(context) : context.obj({});
  adds.forEach((entries, cat) => {
    if (entries.size === 0) return;
    const existing = res.lookup(PDFName.of(cat));
    const sub = existing instanceof PDFDict ? existing.clone(context) : context.obj({});
    entries.forEach((ref, name) => sub.set(PDFName.of(name), ref));
    res.set(PDFName.of(cat), sub);
  });
  return res;
}

/** TJ replacement for a text op with some glyphs removed. */
function rebuildTextOp(info: TextOpInfo, removed: Set<number>, glyphs: GlyphInfo[]): string {
  const parts: string[] = [];
  let pending: number[] = [];
  const flush = () => {
    if (pending.length) parts.push(formatHex(new Uint8Array(pending)));
    pending = [];
  };
  for (const el of info.elements) {
    if (el.type === 'num') {
      flush();
      parts.push(formatNumber(el.value));
      continue;
    }
    el.spans.forEach((span, i) => {
      const gid = el.glyphIds[i];
      const g = gid !== undefined ? glyphs[gid] : undefined;
      if (g && removed.has(gid) && g.fontSize !== 0) {
        flush();
        const value = (g.advText * 1000) / g.fontSize;
        parts.push(formatNumber(g.font.vertical ? value : -value));
      } else {
        for (let k = 0; k < span.len; k++) pending.push(el.bytes[span.start + k]);
      }
    });
    flush();
  }
  let prefix = '';
  if (info.kind === "'") prefix = 'T* ';
  if (info.kind === '"') prefix = `${formatNumber(info.aw ?? 0)} Tw ${formatNumber(info.ac ?? 0)} Tc T* `;
  return `${prefix}[${parts.join(' ')}] TJ`;
}

function rebuildContext(bytes: Uint8Array, ops: { start: number; end: number }[], reps: Map<number, string>): string {
  const src = latin1.decode(bytes);
  if (reps.size === 0) return src;
  const order = [...reps.keys()].sort((a, b) => ops[a].start - ops[b].start);
  let out = '';
  let pos = 0;
  for (const idx of order) {
    const op = ops[idx];
    if (op.start < pos) continue;
    out += src.slice(pos, op.start) + reps.get(idx)!;
    pos = op.end;
  }
  return out + src.slice(pos);
}

// ------------------------------------------------------------- typesetting

/** One font usable for drawing: the document's own, or one we embedded. */
interface Face {
  ref: PDFRef;
  has(ch: string): boolean;
  /** Advance of one character, em units. */
  width(ch: string): number;
  /** Hex operand for a run of characters this face has. */
  encode(text: string): string;
  hasSpace: boolean;
  ascent: number;
}

interface TypesetLine {
  text: string;
  along: number;
  perp: number;
  /** Target width for justified lines. */
  justifyTo?: number;
}

function originalFace(context: PDFContext, font: FontModel): Face {
  const cache = new Map<string, number | null>();
  const codeWidth = (ch: string): number | null => {
    if (!cache.has(ch)) {
      const enc = font.encode(ch);
      cache.set(ch, enc ? enc.codes.reduce((sum, c) => sum + font.width(c), 0) : null);
    }
    return cache.get(ch)!;
  };
  return {
    ref: asRef(context, font.raw),
    has: (ch) => codeWidth(ch) !== null,
    width: (ch) => codeWidth(ch) ?? 0.5,
    encode: (text) => formatHex(font.encode(text)?.bytes ?? new Uint8Array(0)),
    hasSpace: codeWidth(' ') !== null,
    ascent: font.ascent,
  };
}

function libFace(font: PDFFont): Face {
  const widths = new Map<string, number>();
  const has = (ch: string) => {
    try {
      font.encodeText(ch);
      return true;
    } catch {
      return false;
    }
  };
  return {
    ref: font.ref,
    has,
    width: (ch) => {
      let w = widths.get(ch);
      if (w === undefined) {
        w = has(ch) ? font.widthOfTextAtSize(ch, 1) : 0.5;
        widths.set(ch, w);
      }
      return w;
    },
    encode: (text) => {
      const encoded: unknown = font.encodeText(text);
      // Shaped text comes with positioning: splice it into the surrounding TJ.
      return encoded instanceof GlyphRun ? encoded.inner() : String(encoded);
    },
    hasSpace: true,
    ascent: Math.max(0.6, font.heightAtSize(1, { descender: false })),
  };
}

/**
 * Draws text with a primary face (usually the document's own font) and a
 * fallback for any character the primary lacks — so fixing a typo in a
 * subset-embedded font only swaps the characters that aren't in it.
 */
class Typesetter {
  constructor(
    private readonly primary: Face,
    /** Face for a character the primary can't draw (one per script: Latin, Devanagari, CJK). */
    private readonly fallbackFor: ((ch: string) => Face) | null,
    private readonly nameOf: (ref: PDFRef) => string
  ) {}

  get ascent() {
    return this.primary.ascent;
  }

  private faceFor(ch: string): Face {
    // Hindi/Marathi syllables are always drawn with the shaping font, whole.
    if (this.fallbackFor && (needsShaping(ch) || !this.primary.has(ch))) return this.fallbackFor(ch);
    return this.primary;
  }

  /** Width of an inter-word space, em. */
  private spaceWidth(): number {
    if (this.primary.hasSpace) return this.primary.width(' ');
    if (this.fallbackFor) return this.fallbackFor(' ').width(' ');
    return 0.28;
  }

  measure(text: string): number {
    let w = 0;
    for (const ch of graphemes(text)) w += ch === ' ' ? this.spaceWidth() : this.faceFor(ch).width(ch);
    return w;
  }

  /** TJ-based drawing of one line; `extra` is additional space (pt) per word gap. */
  emit(text: string, size: number, extra: number): string {
    const runs: Array<{ face: Face; text: string } | { space: true }> = [];
    for (const ch of graphemes(text)) {
      if (ch === ' ') {
        runs.push({ space: true });
        continue;
      }
      const face = this.faceFor(ch);
      const last = runs[runs.length - 1];
      if (last && 'face' in last && last.face === face) last.text += ch;
      else runs.push({ face, text: ch });
    }
    let out = '';
    let current: Face | null = null;
    let tj: string[] = [];
    const flush = () => {
      if (tj.length) out += `[${tj.join(' ')}] TJ `;
      tj = [];
    };
    const switchTo = (face: Face) => {
      if (current === face) return;
      flush();
      out += `${formatName(this.nameOf(face.ref))} ${formatNumber(size)} Tf `;
      current = face;
    };
    for (const run of runs) {
      if ('space' in run) {
        // A real space glyph when the active font has one (keeps copy/paste
        // and search working), otherwise a plain displacement.
        const active: Face = current ?? this.primary;
        switchTo(active);
        if (active.hasSpace) tj.push(active.encode(' '));
        else tj.push(formatNumber(-this.spaceWidth() * 1000));
        if (extra) tj.push(formatNumber((-extra / size) * 1000));
        continue;
      }
      switchTo(run.face);
      tj.push(run.face.encode(run.text));
    }
    flush();
    return out;
  }
}

async function buildTypesetter(
  doc: PDFDocument,
  text: string,
  style: EditStyle,
  original: FontModel | null,
  nameOf: (ref: PDFRef) => string
): Promise<Typesetter> {
  const family: FontFamily = style.fontChoice === 'original' ? original?.family ?? 'sans' : style.fontChoice;
  const req = { family, bold: style.bold, italic: style.italic };
  const useOriginal =
    original && style.fontChoice === 'original' && style.bold === original.bold && style.italic === original.italic;
  // The document's own font, or the standard font for the chosen family; characters
  // it can't draw get an embedded font for their script (several scripts can mix).
  const primary = useOriginal ? originalFace(doc.context, original) : libFace(await standardFont(doc, req));
  const missing = graphemes(text).filter((ch) => ch !== ' ' && ch !== '\n' && (needsShaping(ch) || !primary.has(ch)));
  if (!missing.length && primary.hasSpace) return new Typesetter(primary, null, nameOf);
  const byScript = new Map<string, Face>();
  for (const script of new Set(missing.map(scriptOf).concat(missing.length ? [] : ['liberation']))) {
    const chars = missing.filter((ch) => scriptOf(ch) === script).join('') || ' ';
    byScript.set(script, libFace(await fontForText(doc, req, chars)));
  }
  const first = byScript.values().next().value as Face;
  return new Typesetter(primary, (ch) => byScript.get(scriptOf(ch)) ?? first, nameOf);
}

function wrapParagraph(text: string, width: number, measure: (t: string) => number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const word of words) {
    const candidate = cur === '' ? word : `${cur} ${word}`;
    if (cur !== '' && measure(candidate) > width) {
      lines.push(cur);
      cur = word;
    } else {
      cur = candidate;
    }
  }
  lines.push(cur);
  return lines;
}

interface Frame {
  d: [number, number];
  n: [number, number];
}

/** Emits BT…ET ops drawing `lines` in a viewer-space frame, converted to user space. */
function drawLines(lines: TypesetLine[], frame: Frame, v2u: Matrix, ts: Typesetter, size: number, color: string): string {
  const [ux, uy] = normalize(applyVector(v2u, frame.d[0], frame.d[1]));
  const [upx, upy] = normalize(applyVector(v2u, -frame.n[0], -frame.n[1]));
  let out = `BT ${rgbOps(color)}\n`;
  for (const line of lines) {
    if (!line.text) continue;
    const vx = line.along * frame.d[0] + line.perp * frame.n[0];
    const vy = line.along * frame.d[1] + line.perp * frame.n[1];
    const [ox, oy] = apply(v2u, vx, vy);
    let extra = 0;
    if (line.justifyTo !== undefined) {
      const gaps = line.text.split(' ').length - 1;
      const natural = ts.measure(line.text) * size;
      const e = gaps > 0 ? (line.justifyTo - natural) / gaps : 0;
      if (e > 0 && e < size * 3) extra = e;
    }
    out += `${[ux, uy, upx, upy, ox, oy].map(formatNumber).join(' ')} Tm ${ts.emit(line.text, size, extra)}\n`;
  }
  return out + 'ET\n';
}

function normalize([x, y]: [number, number]): [number, number] {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

function alignedAlong(align: TextAlign, x0: number, width: number, lineWidth: number): number {
  if (align === 'center') return x0 + (width - lineWidth) / 2;
  if (align === 'right') return x0 + width - lineWidth;
  return x0;
}

function sanitizeText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
}

// ------------------------------------------------------------------ main

export interface AnalyzedPage {
  model: PageModel;
  blocks: TextBlock[];
}

export function analyzePage(page: PDFPage, pageIndex: number): AnalyzedPage {
  const model = interpretPage(page);
  return { model, blocks: buildBlocks(model, pageIndex) };
}

export async function applyPageEdits(doc: PDFDocument, page: PDFPage, edits: PageEdits): Promise<void> {
  if (!pageHasEdits(edits)) return;
  const context = doc.context;
  const { model, blocks } = analyzePage(page, edits.pageIndex);
  const blockById = new Map(blocks.map((b) => [b.id, b]));
  const v2u = invert(model.userToViewer);

  // Per-context op replacements and resource additions.
  const reps = new Map<number, Map<number, string>>();
  const adds = new Map<number, ResourceAdds>();
  const repFor = (ctx: number) => {
    let m = reps.get(ctx);
    if (!m) reps.set(ctx, (m = new Map()));
    return m;
  };
  const addsFor = (ctx: number): ResourceAdds => {
    let m = adds.get(ctx);
    if (!m) adds.set(ctx, (m = new Map([['Font', new Map()], ['XObject', new Map()], ['ExtGState', new Map()]])));
    return m;
  };

  // --- 1. glyph removal for edited / deleted / moved blocks
  const removed = new Set<number>();
  const blockEdits = edits.blocks.filter((e) => blockById.has(e.id));
  for (const e of blockEdits) {
    const b = blockById.get(e.id)!;
    const changed =
      e.deleted ||
      (e.text !== undefined && e.text !== b.text) ||
      !!e.dx ||
      !!e.dy ||
      e.width !== undefined ||
      (e.style && Object.keys(e.style).length > 0);
    if (changed) b.glyphIds.forEach((id) => removed.add(id));
  }
  const touchedOps = new Set<string>();
  removed.forEach((id) => {
    const g = model.glyphs[id];
    touchedOps.add(`${g.ctx}:${g.op}`);
  });
  touchedOps.forEach((key) => {
    const info = model.textOps.get(key);
    if (!info) return;
    repFor(info.ctx).set(info.op, rebuildTextOp(info, removed, model.glyphs));
  });

  // --- 2. existing images
  const u2v = model.userToViewer;
  for (const ie of edits.images) {
    const img = model.images[ie.id];
    if (!img) continue;
    const ctx = model.contexts[img.ctx];
    const opBytes = latin1.decode(ctx.bytes.subarray(ctx.ops[img.op].start, ctx.ops[img.op].end));
    if (ie.deleted) {
      repFor(img.ctx).set(img.op, '');
    } else if (ie.box && img.box.width > 0 && img.box.height > 0) {
      const sx = ie.box.width / img.box.width;
      const sy = ie.box.height / img.box.height;
      const tView: Matrix = [sx, 0, 0, sy, ie.box.x - img.box.x * sx, ie.box.y - img.box.y * sy];
      const tUser = multiply(multiply(u2v, tView), v2u);
      const x = multiply(multiply(img.ctm, tUser), invert(img.ctm));
      repFor(img.ctx).set(img.op, `q ${x.map(formatNumber).join(' ')} cm ${opBytes} Q`);
    }
  }

  // --- 3. drawing new content (appended to the page)
  const pageRes = model.contexts[0].resources;
  const namer = new ResourceNamer(pageRes);
  const pageAdds = addsFor(0);
  const fontNames = new Map<PDFRef, string>();
  const fontName = (ref: PDFRef) => {
    let name = fontNames.get(ref);
    if (!name) {
      name = namer.next('IHF');
      fontNames.set(ref, name);
      pageAdds.get('Font')!.set(name, ref);
    }
    return name;
  };
  let draw = '';

  for (const e of blockEdits) {
    const b = blockById.get(e.id)!;
    if (e.deleted || !removed.has(b.glyphIds[0])) continue;
    const style: EditStyle = { ...b.style, fontChoice: 'original', ...e.style };
    const text = sanitizeText(e.text ?? b.text);
    if (!text.trim()) continue;
    const ts = await buildTypesetter(doc, text, style, b.font, fontName);
    const size = style.fontSize;
    const scale = size / (b.style.fontSize || size);
    const [dx, dy] = b.dir;
    const shiftAlong = (e.dx ?? 0) * dx + (e.dy ?? 0) * dy;
    const shiftPerp = (e.dx ?? 0) * -dy + (e.dy ?? 0) * dx;
    const x0 = b.frame.x0 + shiftAlong;
    const width = e.width ?? (b.frame.x1 - b.frame.x0) * scale;
    const lines: TypesetLine[] = [];
    const sameText = text === b.text && e.width === undefined && Math.abs(scale - 1) < 1e-6;

    if (sameText) {
      // Keep the original line breaks and per-line positions exactly.
      for (const l of b.lines) {
        const justify = style.align === 'justify' && !l.hardBreak;
        lines.push({
          text: l.text,
          along: l.x0 + shiftAlong,
          perp: l.perp + shiftPerp,
          justifyTo: justify ? l.x1 - l.x0 : undefined,
        });
      }
    } else {
      const lineHeight = b.frame.lineHeight * scale;
      let perp = b.frame.firstPerp + shiftPerp;
      const measure = (t: string) => ts.measure(t) * size;
      text.split('\n').forEach((para, pi) => {
        const wrapped = wrapParagraph(para, width, measure);
        wrapped.forEach((lineText, li) => {
          const w = measure(lineText);
          const indent = pi === 0 && li === 0 && style.align === 'left' ? b.frame.firstX - b.frame.x0 : 0;
          const isLast = li === wrapped.length - 1;
          lines.push({
            text: lineText,
            along: alignedAlong(style.align, x0 + indent, width - indent, w),
            perp,
            justifyTo: style.align === 'justify' && !isLast ? width - indent : undefined,
          });
          perp += lineHeight;
        });
      });
    }
    draw += drawLines(lines, { d: b.dir, n: [-dy, dx] }, v2u, ts, size, style.color);
  }

  for (const t of edits.texts) {
    const text = sanitizeText(t.text);
    if (!text.trim()) continue;
    const ts = await buildTypesetter(doc, text, t.style, null, fontName);
    const size = t.style.fontSize;
    const measure = (s: string) => ts.measure(s) * size;
    const lineHeight = size * 1.25;
    const lines: TypesetLine[] = [];
    // Same baseline a browser puts in a line box of this height (Arial-like
    // metrics), so the committed text lands where it was typed.
    let perp = t.y + (lineHeight - 1.12 * size) / 2 + 0.9 * size;
    for (const para of text.split('\n')) {
      const wrapped = t.width > 0 ? wrapParagraph(para, t.width, measure) : [para];
      wrapped.forEach((lineText, li) => {
        const w = measure(lineText);
        lines.push({
          text: lineText,
          along: t.width > 0 ? alignedAlong(t.style.align, t.x, t.width, w) : t.x,
          perp,
          justifyTo: t.style.align === 'justify' && li < wrapped.length - 1 ? t.width : undefined,
        });
        perp += lineHeight;
      });
    }
    draw += drawLines(lines, { d: [1, 0], n: [0, 1] }, v2u, ts, size, t.style.color);
  }

  const gsCache = new Map<string, string>();
  const gsName = (opacity: number, multiplyBlend: boolean) => {
    const key = `${opacity}:${multiplyBlend}`;
    let name = gsCache.get(key);
    if (!name) {
      name = namer.next('IHG');
      const dict = context.obj({ Type: 'ExtGState', ca: opacity, CA: opacity, ...(multiplyBlend ? { BM: 'Multiply' } : {}) });
      pageAdds.get('ExtGState')!.set(name, context.register(dict));
      gsCache.set(key, name);
    }
    return name;
  };

  const v2uCm = `${v2u.map(formatNumber).join(' ')} cm`;
  for (const s of edits.shapes) {
    const highlight = s.kind === 'highlight';
    const opacity = highlight ? Math.min(s.opacity, 0.6) : s.opacity;
    let ops = `q ${v2uCm} `;
    if (opacity < 1 || highlight) ops += `${formatName(gsName(opacity, highlight))} gs `;
    const fill = highlight ? s.fill ?? '#FFE066' : s.fill;
    if (fill) ops += rgbOps(fill) + ' ';
    if (s.stroke && !highlight) ops += `${rgbOps(s.stroke, true)} ${formatNumber(s.strokeWidth)} w `;
    const paint = fill && s.stroke && !highlight ? 'B' : fill ? 'f' : 'S';
    const { x, y, width: w, height: h } = s;
    if (s.kind === 'line') {
      ops += `${rgbOps(s.stroke ?? fill ?? '#000000', true)} ${formatNumber(s.strokeWidth)} w 1 J `;
      ops += `${formatNumber(x)} ${formatNumber(y)} m ${formatNumber(x + w)} ${formatNumber(y + h)} l S`;
    } else if (s.kind === 'ellipse') {
      const k = 0.5522847498;
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = w / 2;
      const ry = h / 2;
      const f = formatNumber;
      ops +=
        `${f(cx + rx)} ${f(cy)} m ` +
        `${f(cx + rx)} ${f(cy + ry * k)} ${f(cx + rx * k)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c ` +
        `${f(cx - rx * k)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + ry * k)} ${f(cx - rx)} ${f(cy)} c ` +
        `${f(cx - rx)} ${f(cy - ry * k)} ${f(cx - rx * k)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c ` +
        `${f(cx + rx * k)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - ry * k)} ${f(cx + rx)} ${f(cy)} c ${paint}`;
    } else {
      ops += `${formatNumber(x)} ${formatNumber(y)} ${formatNumber(w)} ${formatNumber(h)} re ${paint}`;
    }
    draw += ops + ' Q\n';
  }

  for (const im of edits.addedImages) {
    const embedded = im.type === 'png' ? await doc.embedPng(im.bytes) : await doc.embedJpg(im.bytes);
    const name = namer.next('IHI');
    pageAdds.get('XObject')!.set(name, embedded.ref);
    const placement: Matrix = multiply([im.width, 0, 0, -im.height, im.x, im.y + im.height], v2u);
    draw += `q ${placement.map(formatNumber).join(' ')} cm ${formatName(name)} Do Q\n`;
  }

  // --- 4. write changed form XObjects (deepest first), renaming their Do in the parent
  const formRenamer = new Map<number, ResourceNamer>();
  for (let ctxId = model.contexts.length - 1; ctxId >= 1; ctxId--) {
    const ctx = model.contexts[ctxId];
    const ctxReps = reps.get(ctxId);
    const ctxAdds = adds.get(ctxId);
    if (!ctxReps?.size && !ctxAdds) continue;
    if (!ctx.stream || ctx.parent === null) continue;
    const newBytes = latin1.encode(rebuildContext(ctx.bytes, ctx.ops, ctxReps ?? new Map()));
    const dict = ctx.stream.dict.clone(context);
    ['Filter', 'DecodeParms', 'Length', 'DL'].forEach((k) => dict.delete(PDFName.of(k)));
    if (ctxAdds) dict.set(PDFName.of('Resources'), cloneResources(context, ctx.resources, ctxAdds));
    const flate = context.flateStream(newBytes);
    const stream = PDFRawStream.of(dict, flate.getContents());
    stream.dict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    const ref = context.register(stream);

    const parent = model.contexts[ctx.parent];
    let parentNamer = formRenamer.get(parent.id);
    if (!parentNamer) {
      parentNamer = parent.id === 0 ? namer : new ResourceNamer(parent.resources);
      formRenamer.set(parent.id, parentNamer);
    }
    const newName = parentNamer.next('IHX');
    addsFor(parent.id).get('XObject')!.set(newName, ref);
    repFor(parent.id).set(ctx.parentOp, `${formatName(newName)} Do`);
  }

  // --- 5. write the page content: original (edited) wrapped in q/Q, then new drawing
  const page0 = model.contexts[0];
  let body = rebuildContext(page0.bytes, page0.ops, reps.get(0) ?? new Map());
  if (page0.endsInText) body += '\nET';
  body += '\n' + 'Q\n'.repeat(page0.endDepth);
  const content = `q\n${body}Q\n${draw}`;
  const contentStream = context.flateStream(latin1.encode(content));
  const contentRef = context.register(contentStream);
  page.node.set(PDFName.of('Contents'), contentRef);
  page.node.set(PDFName.of('Resources'), cloneResources(context, pageRes, pageAdds));
}

export function isStreamObject(o: unknown): o is PDFStream {
  return o instanceof PDFStream;
}
