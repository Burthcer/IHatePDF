/**
 * Content-stream interpreter.
 *
 * Walks a page's content (and every form XObject it draws, recursively)
 * tracking the graphics and text state the way a renderer does, and records
 * for every shown glyph: which operation/element/bytes produced it, its
 * Unicode text, font, size, color, and exact position. Images are recorded
 * with their placement matrix. Nothing is rendered — this is the model the
 * editor uses to find, remove and re-typeset text.
 */

import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream, type PDFObject, type PDFPage } from 'pdf-lib';
import { parseContent, type ContentOp, type Operand } from './lexer';
import { buildFontModel, type CodeSpan, type FontModel } from './fontModel';
import { IDENTITY, apply, applyVector, multiply, userToViewer, type Matrix } from './geometry';
import { dictDict, dictName, numberArray, objectKey, streamBytes } from './pdfObjects';

export interface GlyphInfo {
  id: number;
  ctx: number;
  op: number;
  /** Index of the TJ array element (0 for Tj/'/"). */
  el: number;
  code: number;
  byteStart: number;
  byteLen: number;
  text: string | undefined;
  font: FontModel;
  /** Tf size (unscaled text space). */
  fontSize: number;
  /** Advance in unscaled text space: w0·Tfs + Tc (+ Tw). */
  advText: number;
  /** Text rendering matrix (em space → user space). */
  trm: Matrix;
  /** Glyph advance width in em units (w0). */
  w0: number;
  color: string;
  mode: number;
  // Viewer-space geometry (points, y down, as displayed)
  vx: number;
  vy: number;
  vdx: number;
  vdy: number;
  vSize: number;
  vWidth: number;
}

export type TextOpElement =
  | { type: 'str'; bytes: Uint8Array; spans: CodeSpan[]; glyphIds: number[] }
  | { type: 'num'; value: number };

export interface TextOpInfo {
  ctx: number;
  op: number;
  kind: 'Tj' | 'TJ' | "'" | '"';
  elements: TextOpElement[];
  fontSize: number;
  /** For `"`: the word/char spacing operands, which also persist as Tw/Tc. */
  aw?: number;
  ac?: number;
}

export interface ImageInfo {
  id: number;
  ctx: number;
  op: number;
  kind: 'xobject' | 'inline';
  /** Image unit square → user space. */
  ctm: Matrix;
  /** Axis-aligned viewer-space box. */
  box: { x: number; y: number; width: number; height: number };
}

export interface ContextInfo {
  id: number;
  parent: number | null;
  /** Index of the `Do` op in the parent that draws this form. */
  parentOp: number;
  xobjectName?: string;
  stream?: PDFStream;
  resources: PDFDict | undefined;
  bytes: Uint8Array;
  ops: ContentOp[];
  /** Unbalanced `q` count left at the end of this context. */
  endDepth: number;
  endsInText: boolean;
}

export interface PageModel {
  contexts: ContextInfo[];
  glyphs: GlyphInfo[];
  textOps: Map<string, TextOpInfo>;
  images: ImageInfo[];
  userToViewer: Matrix;
  viewerWidth: number;
  viewerHeight: number;
}

interface ColorState {
  space: string;
  components: number;
  rgb: string;
}

interface GState {
  ctm: Matrix;
  fill: ColorState;
  stroke: ColorState;
  font: FontModel | null;
  fontSize: number;
  tc: number;
  tw: number;
  th: number;
  tl: number;
  rise: number;
  mode: number;
}

const BLACK: ColorState = { space: 'DeviceGray', components: 1, rgb: '#000000' };

function hex2(v: number): string {
  return Math.round(Math.min(1, Math.max(0, v)) * 255)
    .toString(16)
    .padStart(2, '0');
}

function toRgbHex(space: string, comps: number[]): string | null {
  switch (space) {
    case 'DeviceGray':
    case 'CalGray':
    case 'G':
      return '#' + hex2(comps[0] ?? 0).repeat(3);
    case 'DeviceRGB':
    case 'CalRGB':
    case 'RGB':
      return '#' + hex2(comps[0] ?? 0) + hex2(comps[1] ?? 0) + hex2(comps[2] ?? 0);
    case 'DeviceCMYK':
    case 'CMYK': {
      const [c = 0, m = 0, y = 0, k = 0] = comps;
      return '#' + hex2((1 - c) * (1 - k)) + hex2((1 - m) * (1 - k)) + hex2((1 - y) * (1 - k));
    }
    case 'Separation':
      return '#' + hex2(1 - (comps[0] ?? 1)).repeat(3);
    default:
      return null;
  }
}

function num(o: Operand | undefined): number {
  return o && o.t === 'num' ? o.v : 0;
}

export function interpretPage(page: PDFPage): PageModel {
  const { matrix: u2v, width: viewerWidth, height: viewerHeight } = userToViewer(page);
  const contexts: ContextInfo[] = [];
  const glyphs: GlyphInfo[] = [];
  const textOps = new Map<string, TextOpInfo>();
  const images: ImageInfo[] = [];
  const fontCache = new Map<string, FontModel>();

  const pageResources = (() => {
    const own = page.node.lookup(PDFName.of('Resources'));
    if (own instanceof PDFDict) return own;
    const inherited = page.node.Resources();
    return inherited instanceof PDFDict ? inherited : undefined;
  })();

  const contentsBytes = (): Uint8Array => {
    const contents = page.node.lookup(PDFName.of('Contents'));
    const parts: Uint8Array[] = [];
    if (contents instanceof PDFStream) {
      const b = streamBytes(contents);
      if (b) parts.push(b);
    } else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const b = streamBytes(contents.lookup(i));
        if (b) parts.push(b);
      }
    }
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.length;
      out[off++] = 0x0a;
    }
    return out;
  };

  const resolveColorSpace = (resources: PDFDict | undefined, name: string): { space: string; components: number } => {
    const shortcuts: Record<string, [string, number]> = {
      DeviceGray: ['DeviceGray', 1],
      G: ['DeviceGray', 1],
      DeviceRGB: ['DeviceRGB', 3],
      RGB: ['DeviceRGB', 3],
      DeviceCMYK: ['DeviceCMYK', 4],
      CMYK: ['DeviceCMYK', 4],
      Pattern: ['Pattern', 1],
    };
    if (shortcuts[name]) return { space: shortcuts[name][0], components: shortcuts[name][1] };
    const csDict = dictDict(resources, 'ColorSpace');
    const cs = csDict?.lookup(PDFName.of(name));
    const describe = (obj: PDFObject | undefined): { space: string; components: number } => {
      if (obj instanceof PDFName) return resolveColorSpace(undefined, obj.decodeText());
      if (obj instanceof PDFArray && obj.size() > 0) {
        const family = obj.lookup(0);
        const fam = family instanceof PDFName ? family.decodeText() : '';
        if (fam === 'ICCBased') {
          const stream = obj.lookup(1);
          const n = stream instanceof PDFStream ? stream.dict.lookup(PDFName.of('N')) : undefined;
          const count = n instanceof PDFNumber ? n.asNumber() : 3;
          return { space: count === 1 ? 'DeviceGray' : count === 4 ? 'DeviceCMYK' : 'DeviceRGB', components: count };
        }
        if (fam === 'CalRGB') return { space: 'DeviceRGB', components: 3 };
        if (fam === 'CalGray') return { space: 'DeviceGray', components: 1 };
        if (fam === 'Lab') return { space: 'Lab', components: 3 };
        if (fam === 'Separation') return { space: 'Separation', components: 1 };
        if (fam === 'DeviceN') {
          const names = obj.lookup(1);
          return { space: 'DeviceN', components: names instanceof PDFArray ? names.size() : 1 };
        }
        if (fam === 'Indexed') return { space: 'Indexed', components: 1 };
        if (fam === 'Pattern') return { space: 'Pattern', components: 1 };
        return describe(family);
      }
      return { space: 'DeviceRGB', components: 3 };
    };
    return describe(cs);
  };

  const loadFont = (resources: PDFDict | undefined, name: string): FontModel | null => {
    const fonts = dictDict(resources, 'Font');
    if (!fonts) return null;
    const raw = fonts.get(PDFName.of(name));
    const resolved = fonts.lookup(PDFName.of(name));
    if (!(resolved instanceof PDFDict)) return null;
    const key = objectKey(raw, resolved, name);
    let model = fontCache.get(key);
    if (!model) {
      model = buildFontModel(raw ?? resolved, resolved, key);
      fontCache.set(key, model);
    }
    return model;
  };

  const run = (
    ctxId: number,
    resources: PDFDict | undefined,
    initial: GState,
    depth: number,
    visiting: Set<PDFStream>
  ) => {
    const ctx = contexts[ctxId];
    const ops = ctx.ops;
    let gs: GState = { ...initial };
    const stack: GState[] = [];
    let tm: Matrix = IDENTITY;
    let tlm: Matrix = IDENTITY;
    let inText = false;

    const showString = (op: number, info: TextOpInfo, bytes: Uint8Array, el: number) => {
      const font = gs.font;
      const spans = font ? font.decode(bytes) : [];
      const glyphIds: number[] = [];
      info.elements.push({ type: 'str', bytes, spans, glyphIds });
      if (!font) return;
      const fs = gs.fontSize;
      for (const span of spans) {
        font.observed.add(span.code);
        const w0 = font.width(span.code);
        const isSpace = span.len === 1 && span.code === 32;
        const advText = w0 * fs + gs.tc + (isSpace ? gs.tw : 0);
        const trm = multiply(multiply([fs * gs.th, 0, 0, fs, 0, gs.rise], tm), gs.ctm);
        const [ox, oy] = apply(trm, 0, 0);
        const [ex, ey] = apply(trm, w0, 0);
        const [vx, vy] = apply(u2v, ox, oy);
        const [vex, vey] = apply(u2v, ex, ey);
        let [dx, dy] = applyVector(u2v, ...applyVector(trm, 1, 0));
        const dirLen = Math.hypot(dx, dy) || 1;
        dx /= dirLen;
        dy /= dirLen;
        const [upx, upy] = applyVector(u2v, ...applyVector(trm, 0, 1));
        const id = glyphs.length;
        glyphs.push({
          id,
          ctx: ctxId,
          op,
          el,
          code: span.code,
          byteStart: span.start,
          byteLen: span.len,
          text: font.unicode(span.code),
          font,
          fontSize: fs,
          advText,
          trm,
          w0,
          color: gs.mode === 1 ? gs.stroke.rgb : gs.fill.rgb,
          mode: gs.mode,
          vx,
          vy,
          vdx: dx,
          vdy: dy,
          vSize: Math.hypot(upx, upy),
          vWidth: Math.hypot(vex - vx, vey - vy),
        });
        glyphIds.push(id);
        const tx = advText * gs.th;
        tm = font.vertical ? multiply([1, 0, 0, 1, 0, -advText], tm) : multiply([1, 0, 0, 1, tx, 0], tm);
      }
    };

    const adjust = (value: number) => {
      const shift = (-value / 1000) * gs.fontSize;
      tm = gs.font?.vertical ? multiply([1, 0, 0, 1, 0, shift], tm) : multiply([1, 0, 0, 1, shift * gs.th, 0], tm);
    };

    const nextLine = () => {
      tlm = multiply([1, 0, 0, 1, 0, -gs.tl], tlm);
      tm = tlm;
    };

    for (let i = 0; i < ops.length; i++) {
      const { op, args } = ops[i];
      switch (op) {
        case 'q':
          stack.push({ ...gs });
          break;
        case 'Q':
          if (stack.length) gs = stack.pop()!;
          break;
        case 'cm':
          if (args.length >= 6) gs.ctm = multiply(args.slice(0, 6).map(num) as Matrix, gs.ctm);
          break;
        case 'BT':
          inText = true;
          tm = IDENTITY;
          tlm = IDENTITY;
          break;
        case 'ET':
          inText = false;
          break;
        case 'Tf': {
          const nameOp = args[0];
          if (nameOp && nameOp.t === 'name') gs.font = loadFont(resources, nameOp.v);
          gs.fontSize = num(args[1]);
          break;
        }
        case 'Tc':
          gs.tc = num(args[0]);
          break;
        case 'Tw':
          gs.tw = num(args[0]);
          break;
        case 'Tz':
          gs.th = num(args[0]) / 100;
          break;
        case 'TL':
          gs.tl = num(args[0]);
          break;
        case 'Ts':
          gs.rise = num(args[0]);
          break;
        case 'Tr':
          gs.mode = num(args[0]);
          break;
        case 'Td':
          tlm = multiply([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
          tm = tlm;
          break;
        case 'TD':
          gs.tl = -num(args[1]);
          tlm = multiply([1, 0, 0, 1, num(args[0]), num(args[1])], tlm);
          tm = tlm;
          break;
        case 'Tm':
          if (args.length >= 6) {
            tlm = args.slice(0, 6).map(num) as Matrix;
            tm = tlm;
          }
          break;
        case 'T*':
          nextLine();
          break;
        case 'Tj':
        case "'":
        case '"':
        case 'TJ': {
          if (op === "'") nextLine();
          const info: TextOpInfo = { ctx: ctxId, op: i, kind: op as TextOpInfo['kind'], elements: [], fontSize: gs.fontSize };
          if (op === '"') {
            info.aw = num(args[0]);
            info.ac = num(args[1]);
            gs.tw = info.aw;
            gs.tc = info.ac;
            nextLine();
          }
          const operand = args[args.length - 1];
          if (op === 'TJ') {
            if (operand && operand.t === 'arr') {
              operand.v.forEach((item, el) => {
                if (item.t === 'str') showString(i, info, item.v, el);
                else if (item.t === 'num') {
                  info.elements.push({ type: 'num', value: item.v });
                  adjust(item.v);
                }
              });
            }
          } else if (operand && operand.t === 'str') {
            showString(i, info, operand.v, 0);
          }
          textOps.set(`${ctxId}:${i}`, info);
          break;
        }
        case 'gs': {
          const nameOp = args[0];
          if (nameOp && nameOp.t === 'name') {
            const ext = dictDict(dictDict(resources, 'ExtGState'), nameOp.v);
            const fontEntry = ext?.lookup(PDFName.of('Font'));
            if (fontEntry instanceof PDFArray && fontEntry.size() >= 2) {
              const fontRaw = fontEntry.get(0);
              const fontDict = fontEntry.lookup(0);
              const size = fontEntry.lookup(1);
              if (fontDict instanceof PDFDict) {
                const key = objectKey(fontRaw, fontDict, 'gsfont');
                let model = fontCache.get(key);
                if (!model) {
                  model = buildFontModel(fontRaw, fontDict, key);
                  fontCache.set(key, model);
                }
                gs.font = model;
                gs.fontSize = size instanceof PDFNumber ? size.asNumber() : gs.fontSize;
              }
            }
          }
          break;
        }
        case 'g':
          gs.fill = { space: 'DeviceGray', components: 1, rgb: toRgbHex('DeviceGray', [num(args[0])])! };
          break;
        case 'G':
          gs.stroke = { space: 'DeviceGray', components: 1, rgb: toRgbHex('DeviceGray', [num(args[0])])! };
          break;
        case 'rg':
          gs.fill = { space: 'DeviceRGB', components: 3, rgb: toRgbHex('DeviceRGB', args.map(num))! };
          break;
        case 'RG':
          gs.stroke = { space: 'DeviceRGB', components: 3, rgb: toRgbHex('DeviceRGB', args.map(num))! };
          break;
        case 'k':
          gs.fill = { space: 'DeviceCMYK', components: 4, rgb: toRgbHex('DeviceCMYK', args.map(num))! };
          break;
        case 'K':
          gs.stroke = { space: 'DeviceCMYK', components: 4, rgb: toRgbHex('DeviceCMYK', args.map(num))! };
          break;
        case 'cs':
        case 'CS': {
          const nameOp = args[0];
          if (nameOp && nameOp.t === 'name') {
            const cs = resolveColorSpace(resources, nameOp.v);
            const initialComps = cs.space === 'DeviceCMYK' ? [0, 0, 0, 1] : cs.space === 'Separation' ? [1] : [0, 0, 0];
            const state: ColorState = { ...cs, rgb: toRgbHex(cs.space, initialComps) ?? '#000000' };
            if (op === 'cs') gs.fill = state;
            else gs.stroke = state;
          }
          break;
        }
        case 'sc':
        case 'scn':
        case 'SC':
        case 'SCN': {
          const target = op === 'sc' || op === 'scn' ? gs.fill : gs.stroke;
          const comps = args.filter((a) => a.t === 'num').map(num);
          const rgb = toRgbHex(target.space, comps) ?? target.rgb;
          const next = { ...target, rgb };
          if (op === 'sc' || op === 'scn') gs.fill = next;
          else gs.stroke = next;
          break;
        }
        case 'BI': {
          const [vx0, vy0, vx1, vy1] = viewerBox(u2v, gs.ctm);
          images.push({ id: images.length, ctx: ctxId, op: i, kind: 'inline', ctm: gs.ctm, box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 } });
          break;
        }
        case 'Do': {
          const nameOp = args[0];
          if (!nameOp || nameOp.t !== 'name') break;
          const xobjects = dictDict(resources, 'XObject');
          const xo = xobjects?.lookup(PDFName.of(nameOp.v));
          if (!(xo instanceof PDFStream)) break;
          const subtype = dictName(xo.dict, 'Subtype');
          if (subtype === 'Image') {
            const [vx0, vy0, vx1, vy1] = viewerBox(u2v, gs.ctm);
            images.push({ id: images.length, ctx: ctxId, op: i, kind: 'xobject', ctm: gs.ctm, box: { x: vx0, y: vy0, width: vx1 - vx0, height: vy1 - vy0 } });
          } else if (subtype === 'Form' && depth < 12 && !visiting.has(xo)) {
            const bytes = streamBytes(xo);
            if (!bytes) break;
            const matrix = numberArray(xo.dict.lookup(PDFName.of('Matrix')));
            const formResources = dictDict(xo.dict, 'Resources') ?? resources;
            const childId = contexts.length;
            contexts.push({
              id: childId,
              parent: ctxId,
              parentOp: i,
              xobjectName: nameOp.v,
              stream: xo,
              resources: formResources,
              bytes,
              ops: parseContent(bytes),
              endDepth: 0,
              endsInText: false,
            });
            const childState: GState = {
              ...gs,
              ctm: matrix && matrix.length === 6 ? multiply(matrix as Matrix, gs.ctm) : gs.ctm,
            };
            visiting.add(xo);
            run(childId, formResources, childState, depth + 1, visiting);
            visiting.delete(xo);
          }
          break;
        }
        default:
          break;
      }
    }
    ctx.endDepth = stack.length;
    ctx.endsInText = inText;
  };

  const bytes = contentsBytes();
  contexts.push({
    id: 0,
    parent: null,
    parentOp: -1,
    resources: pageResources,
    bytes,
    ops: parseContent(bytes),
    endDepth: 0,
    endsInText: false,
  });
  const initial: GState = {
    ctm: IDENTITY,
    fill: BLACK,
    stroke: BLACK,
    font: null,
    fontSize: 0,
    tc: 0,
    tw: 0,
    th: 1,
    tl: 0,
    rise: 0,
    mode: 0,
  };
  run(0, pageResources, initial, 0, new Set());

  return { contexts, glyphs, textOps, images, userToViewer: u2v, viewerWidth, viewerHeight };
}

function viewerBox(u2v: Matrix, ctm: Matrix): [number, number, number, number] {
  const m = multiply(ctm, u2v);
  const pts = [apply(m, 0, 0), apply(m, 1, 0), apply(m, 0, 1), apply(m, 1, 1)];
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

export function isRef(o: unknown): o is PDFRef {
  return o instanceof PDFRef;
}
