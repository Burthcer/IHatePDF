/**
 * Groups interpreted glyphs into lines and paragraphs ("blocks") — the units
 * the editor lets you click into and retype, Word-style.
 *
 * Everything here works in viewer space (what the user sees: y down, page
 * rotation applied), in a per-direction frame: `along` runs with the text,
 * `perp` points down the page, so rotated text is grouped the same way.
 */

import type { GlyphInfo, PageModel } from './interpreter';
import type { FontFamilyClass, FontModel } from './fontModel';

export type TextAlign = 'left' | 'center' | 'right' | 'justify';

export interface TextStyle {
  fontSize: number;
  color: string;
  bold: boolean;
  italic: boolean;
  family: FontFamilyClass;
  align: TextAlign;
}

export interface LayoutLine {
  glyphIds: number[];
  text: string;
  /** Start/end along the text direction, baseline position across it. */
  x0: number;
  x1: number;
  perp: number;
  size: number;
  /** Hard break after this line (true) or a soft wrap (false). */
  hardBreak: boolean;
}

export interface TextBlock {
  id: string;
  lines: LayoutLine[];
  text: string;
  glyphIds: number[];
  /** Text direction in viewer space (unit vector) and its angle in degrees. */
  dir: [number, number];
  angle: number;
  box: { x: number; y: number; width: number; height: number };
  /** Paragraph frame in the along/perp system. */
  frame: { x0: number; x1: number; firstX: number; firstPerp: number; lineHeight: number; ascent: number; descent: number };
  style: TextStyle;
  font: FontModel;
  fontName: string;
  editable: boolean;
  reason?: string;
}

interface Chunk {
  glyphs: GlyphInfo[];
  angleKey: number;
  dx: number;
  dy: number;
  x0: number;
  x1: number;
  perp: number;
  size: number;
  dupOf?: Chunk;
}

const isSpace = (t: string | undefined) => t === undefined || /^\s+$/.test(t);

function along(g: GlyphInfo, dx: number, dy: number) {
  return g.vx * dx + g.vy * dy;
}
function perpOf(g: GlyphInfo, dx: number, dy: number) {
  return g.vx * -dy + g.vy * dx;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function dominant<T>(items: T[], weight: (t: T) => number = () => 1): T {
  const counts = new Map<T, number>();
  let best = items[0];
  let bestCount = -1;
  for (const item of items) {
    const c = (counts.get(item) ?? 0) + weight(item);
    counts.set(item, c);
    if (c > bestCount) {
      best = item;
      bestCount = c;
    }
  }
  return best;
}

function buildChunks(glyphs: GlyphInfo[]): Chunk[] {
  const chunks: Chunk[] = [];
  let cur: Chunk | null = null;
  for (const g of glyphs) {
    if (g.mode === 3 || g.mode === 7 || !(g.vSize > 0.5) || !(g.vSize < 2000)) continue;
    const angle = Math.atan2(g.vdy, g.vdx);
    const angleKey = Math.round((angle * 180) / Math.PI);
    if (cur && cur.angleKey === angleKey) {
      const size = Math.max(cur.size, g.vSize);
      const a = along(g, cur.dx, cur.dy);
      const p = perpOf(g, cur.dx, cur.dy);
      const gap = a - cur.x1;
      if (Math.abs(p - cur.perp) < size * 0.3 && gap > -size * 0.6 && gap < size * 1.0) {
        cur.glyphs.push(g);
        cur.x1 = Math.max(cur.x1, a + g.vWidth);
        cur.x0 = Math.min(cur.x0, a);
        cur.size = size;
        continue;
      }
    }
    const rad = (angleKey * Math.PI) / 180;
    const dx = Math.cos(rad);
    const dy = Math.sin(rad);
    const a = along(g, dx, dy);
    cur = { glyphs: [g], angleKey, dx, dy, x0: a, x1: a + g.vWidth, perp: perpOf(g, dx, dy), size: g.vSize };
    chunks.push(cur);
  }
  return chunks;
}

interface RawLine {
  chunks: Chunk[];
  angleKey: number;
  dx: number;
  dy: number;
  x0: number;
  x1: number;
  perp: number;
  size: number;
}

function chunkText(c: Chunk): string {
  return c.glyphs.map((g) => g.text ?? '').join('');
}

function buildLines(chunks: Chunk[]): RawLine[] {
  const byAngle = new Map<number, Chunk[]>();
  for (const c of chunks) {
    const list = byAngle.get(c.angleKey) ?? [];
    list.push(c);
    byAngle.set(c.angleKey, list);
  }
  const lines: RawLine[] = [];
  byAngle.forEach((list) => {
    list.sort((a, b) => a.perp - b.perp);
    const bands: Chunk[][] = [];
    for (const c of list) {
      const band = bands[bands.length - 1];
      if (band) {
        const ref = band[0];
        if (Math.abs(c.perp - ref.perp) < Math.max(c.size, ref.size) * 0.35) {
          band.push(c);
          continue;
        }
      }
      bands.push([c]);
    }
    for (const band of bands) {
      band.sort((a, b) => a.x0 - b.x0);
      let line: RawLine | null = null;
      for (const c of band) {
        if (line) {
          const size = Math.max(line.size, c.size);
          // Overprinted duplicates (fake bold, shadows): same text drawn again
          // almost on top — keep for removal, drop from the text.
          const overlap = Math.min(line.x1, c.x1) - Math.max(c.x0, line.x0);
          const dupTarget = line.chunks.find(
            (o) => !o.dupOf && Math.abs(o.x0 - c.x0) < size * 0.3 && chunkText(o) === chunkText(c)
          );
          if (dupTarget && overlap > 0) {
            c.dupOf = dupTarget;
            line.chunks.push(c);
            continue;
          }
          if (c.x0 - line.x1 < size * 1.0) {
            line.chunks.push(c);
            line.x1 = Math.max(line.x1, c.x1);
            line.size = size;
            continue;
          }
        }
        line = { chunks: [c], angleKey: c.angleKey, dx: c.dx, dy: c.dy, x0: c.x0, x1: c.x1, perp: c.perp, size: c.size };
        lines.push(line);
      }
    }
  });
  return lines;
}

function lineText(line: RawLine): { text: string; glyphIds: number[] } {
  let text = '';
  const glyphIds: number[] = [];
  let prevEnd: number | null = null;
  let prevGlyph: GlyphInfo | null = null;
  const visible = line.chunks.filter((c) => !c.dupOf);
  for (const c of line.chunks) glyphIds.push(...c.glyphs.map((g) => g.id));
  for (const c of visible) {
    for (const g of c.glyphs) {
      const a = along(g, line.dx, line.dy);
      if (prevEnd !== null && prevGlyph) {
        const gap = a - prevEnd;
        if (gap > line.size * 0.17 && !isSpace(g.text) && !isSpace(prevGlyph.text) && !text.endsWith(' ')) text += ' ';
      }
      const t = g.text ?? '�';
      text += t === ' ' || t === '\t' ? ' ' : t;
      prevEnd = Math.max(prevEnd ?? -Infinity, a + g.vWidth);
      prevGlyph = g;
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), glyphIds };
}

export function buildBlocks(model: PageModel, pageIndex: number): TextBlock[] {
  const glyphs = model.glyphs;
  const rawLines = buildLines(buildChunks(glyphs)).filter((l) => l.chunks.some((c) => c.glyphs.some((g) => !isSpace(g.text))));

  interface Acc {
    lines: Array<RawLine & { text: string; glyphIds: number[]; bold: boolean; idx: number }>;
    x0: number;
    x1: number;
    spacing: number | null;
  }
  const blocks: Acc[] = [];
  let open: Acc[] = [];
  const sorted = rawLines
    .map((l) => {
      const { text, glyphIds } = lineText(l);
      const fonts = glyphIds.map((id) => glyphs[id].font);
      const bold = dominant(fonts).bold;
      return { ...l, text, glyphIds, bold };
    })
    .sort((a, b) => a.angleKey - b.angleKey || a.perp - b.perp || a.x0 - b.x0)
    .map((l, idx) => ({ ...l, idx }));

  for (const line of sorted) {
    let best: Acc | null = null;
    let bestDy = Infinity;
    // Blocks whose last line is far above can never grow again.
    open = open.filter((b) => {
      const last = b.lines[b.lines.length - 1];
      return last.angleKey === line.angleKey && line.perp - last.perp <= Math.max(last.size, line.size) * 2;
    });
    for (let bi = open.length - 1; bi >= 0; bi--) {
      const block = open[bi];
      const last = block.lines[block.lines.length - 1];
      if (last.angleKey !== line.angleKey) continue;
      const s = Math.max(last.size, line.size);
      const dy = line.perp - last.perp;
      if (dy < s * 0.55 || dy > s * 1.75) continue;
      const ratio = line.size / last.size;
      if (ratio < 0.83 || ratio > 1.2) continue;
      if (line.bold !== last.bold) continue;
      if (block.spacing !== null && Math.abs(dy - block.spacing) > block.spacing * 0.25) continue;
      const overlap = Math.min(line.x1, block.x1) - Math.max(line.x0, block.x0);
      if (overlap <= 0) continue;
      const leftOk = Math.abs(line.x0 - block.x0) < s * (block.lines.length === 1 ? 3 : 1.5);
      const rightOk = Math.abs(line.x1 - block.x1) < s * 1.5;
      const centerOk = Math.abs((line.x0 + line.x1) / 2 - (block.x0 + block.x1) / 2) < s * 1.5;
      const inside = line.x0 >= block.x0 - s && line.x1 <= block.x1 + s;
      if (!(leftOk || rightOk || centerOk || inside)) continue;
      // Something else sits between the block's last line and this one.
      let blocked = false;
      for (let k = last.idx + 1; k < line.idx && !blocked; k++) {
        const o = sorted[k];
        blocked =
          o.perp > last.perp + s * 0.2 &&
          o.perp < line.perp - s * 0.2 &&
          Math.min(o.x1, line.x1) - Math.max(o.x0, line.x0) > 0;
      }
      if (blocked) continue;
      if (dy < bestDy) {
        best = block;
        bestDy = dy;
      }
    }
    if (best) {
      const prev = best.lines[best.lines.length - 1];
      best.spacing = best.spacing ?? line.perp - prev.perp;
      best.lines.push(line);
      best.x0 = Math.min(best.x0, line.x0);
      best.x1 = Math.max(best.x1, line.x1);
    } else {
      const block: Acc = { lines: [line], x0: line.x0, x1: line.x1, spacing: null };
      blocks.push(block);
      open.push(block);
    }
  }

  return blocks.map((acc, index) => finalizeBlock(acc, index, pageIndex, glyphs));
}

function finalizeBlock(
  acc: { lines: Array<RawLine & { text: string; glyphIds: number[] }>; x0: number; x1: number; spacing: number | null },
  index: number,
  pageIndex: number,
  glyphs: GlyphInfo[]
): TextBlock {
  const first = acc.lines[0];
  const dx = first.dx;
  const dy = first.dy;
  const allIds = acc.lines.flatMap((l) => l.glyphIds);
  const textGlyphs = allIds.map((id) => glyphs[id]).filter((g) => !isSpace(g.text));
  const font = dominant(textGlyphs.map((g) => g.font));
  const color = dominant(textGlyphs.map((g) => g.color));
  const size = median(textGlyphs.map((g) => g.vSize)) || first.size;
  const blockWidth = acc.x1 - acc.x0;
  const avgCharWidth = median(textGlyphs.map((g) => g.vWidth)) || size * 0.5;

  const lines: LayoutLine[] = acc.lines.map((l, i) => {
    let hardBreak = true;
    const next = acc.lines[i + 1];
    if (next) {
      const firstWord = next.text.split(' ')[0] ?? '';
      const nextWordWidth = firstWord.length * avgCharWidth;
      const fits = l.x1 - acc.x0 + size * 0.3 + nextWordWidth <= blockWidth * 1.02;
      hardBreak = fits;
    }
    return { glyphIds: l.glyphIds, text: l.text, x0: l.x0, x1: l.x1, perp: l.perp, size: l.size, hardBreak };
  });

  let text = '';
  lines.forEach((l, i) => {
    text += l.text;
    if (i === lines.length - 1) return;
    if (l.hardBreak) text += '\n';
    else if (/[A-Za-z]-$/.test(l.text) && /^[a-z]/.test(lines[i + 1].text)) text = text.slice(0, -1);
    else text += ' ';
  });

  let align: TextAlign = 'left';
  if (lines.length > 1) {
    const spread = (vals: number[]) => (vals.length ? Math.max(...vals) - Math.min(...vals) : 0);
    const tol = size * 0.5;
    const lefts = lines.slice(1).map((l) => l.x0);
    const rights = lines.slice(0, -1).map((l) => l.x1);
    const centers = lines.map((l) => (l.x0 + l.x1) / 2);
    const leftAligned = spread(lefts) < tol;
    const rightAligned = spread(rights) < tol && rights.length >= 2;
    if (leftAligned && rightAligned && lines.some((l) => !l.hardBreak)) align = 'justify';
    else if (leftAligned && Math.abs(lines[0].x0 - lefts[0]) < size * 3) align = 'left';
    else if (spread(centers) < tol) align = 'center';
    else if (spread(lines.map((l) => l.x1)) < tol) align = 'right';
  }

  const lineHeight = acc.spacing ?? size * 1.2;
  const ascent = font.ascent;
  const descent = font.descent;
  // Axis-aligned viewer box from each line's rotated rectangle.
  const pts: Array<[number, number]> = [];
  for (const l of lines) {
    for (const a of [l.x0, l.x1]) {
      for (const p of [l.perp - ascent * l.size, l.perp - descent * l.size]) {
        pts.push([a * dx - p * dy, a * dy + p * dx]);
      }
    }
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };

  let editable = true;
  let reason: string | undefined;
  if (textGlyphs.some((g) => g.text === undefined)) {
    editable = false;
    reason = 'This text uses a font without a character map, so its characters can’t be read. You can still delete or move it.';
  } else if (!font.reliable) {
    editable = false;
    reason = 'This text uses an encoding (vertical or CJK predefined CMap) that can’t be re-typeset here. You can still delete it.';
  }

  return {
    id: `p${pageIndex}b${index}`,
    lines,
    text,
    glyphIds: allIds,
    dir: [dx, dy],
    angle: Math.round((Math.atan2(dy, dx) * 180) / Math.PI),
    box,
    frame: { x0: acc.x0, x1: acc.x1, firstX: first.x0, firstPerp: first.perp, lineHeight, ascent, descent },
    style: { fontSize: size, color, bold: font.bold, italic: font.italic, family: font.family, align },
    font,
    fontName: font.displayName,
    editable,
    reason,
  };
}
