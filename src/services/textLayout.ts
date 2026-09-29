/**
 * Document structure recovery from pdf.js text content, shared by the
 * "PDF to …" converters.
 *
 * PDF has no paragraphs, headings or tables — only positioned glyph runs.
 * This rebuilds them:
 *   runs → lines (same baseline) → segments (split at wide gaps)
 *   aligned multi-segment lines → tables
 *   remaining segments → blocks (paragraphs), ordered by a recursive
 *   XY-cut so multi-column pages read column by column
 *   blocks → heading / list item / paragraph, by size, weight and markers
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import { OPS, Util } from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface StyledRun {
  text: string;
  bold: boolean;
  italic: boolean;
  size: number;
  fontName: string;
  mono: boolean;
  serif: boolean;
}

export interface LayoutLineOut {
  runs: StyledRun[];
  text: string;
  x0: number;
  x1: number;
  y: number; // baseline, viewer space (top-down)
  size: number;
}

export type LayoutBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; runs: StyledRun[]; text: string; box: Box }
  | { kind: 'paragraph'; runs: StyledRun[]; text: string; box: Box; align: 'left' | 'center' | 'right' | 'justify' }
  | { kind: 'list'; ordered: boolean; items: Array<{ runs: StyledRun[]; text: string; marker: string }>; box: Box }
  | { kind: 'table'; rows: string[][]; box: Box }
  /** A picture on the page (viewer coordinates); `data` is filled in by whoever needs the pixels. */
  | { kind: 'image'; box: Box; data?: Blob };

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface PageLayout {
  pageNumber: number;
  width: number;
  height: number;
  blocks: LayoutBlock[];
  lines: LayoutLineOut[];
}

interface Run {
  text: string;
  x: number;
  y: number;
  w: number;
  size: number;
  bold: boolean;
  italic: boolean;
  fontName: string;
  mono: boolean;
  serif: boolean;
}

interface Segment {
  runs: Run[];
  x0: number;
  x1: number;
  y: number;
  size: number;
}

interface Line {
  /** Runs split where the gap is wider than a generous word space (prose-safe). */
  segments: Segment[];
  /** Split at any gap wider than half an em: candidate cells of a tightly set table. */
  fine: Segment[];
  y: number;
  size: number;
}

const BULLET_RE = /^\s*([•◦▪▫‣⁃●○■□–—\-*·►➢✓✔]|\(?\d{1,3}[.)]|\(?[a-zA-Z][.)]|[ivxIVX]{1,4}[.)])\s+/;

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function fontInfo(page: PDFPageProxy, fontName: string, style: { fontFamily?: string } | undefined) {
  let name = '';
  let bold = false;
  let italic = false;
  try {
    if (page.commonObjs.has(fontName)) {
      const f = page.commonObjs.get(fontName) as { name?: string; bold?: boolean; italic?: boolean; black?: boolean };
      name = (f?.name ?? '').replace(/^[A-Z]{6}\+/, '');
      bold = !!(f?.bold || f?.black);
      italic = !!f?.italic;
    }
  } catch {
    // font not resolved — fall back to name heuristics
  }
  const lower = name.toLowerCase();
  if (/bold|black|heavy|semibold|demi/.test(lower)) bold = true;
  if (/italic|oblique/.test(lower)) italic = true;
  const family = (style?.fontFamily ?? '').toLowerCase();
  const mono = /mono|courier|consol|code/.test(lower) || family === 'monospace';
  const serif = !mono && (/times|serif|roman|georgia|garamond|cambria|minion|book/.test(lower) && !/sans/.test(lower) || family === 'serif');
  return { name, bold, italic, mono, serif };
}

const IMAGE_OPS = new Set([OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject]);
const MIN_IMAGE_PT = 24;

/** Where the page's pictures are drawn, from its operator list (tracking the transform stack). */
function imageBoxes(ops: { fnArray: number[]; argsArray: unknown[][] }, viewport: number[], width: number, height: number): Box[] {
  const boxes: Box[] = [];
  const stack: number[][] = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i];
    const args = ops.argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() ?? ctm;
    else if (fn === OPS.transform) ctm = Util.transform(ctm, args as number[]);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const m = args?.[0] as number[] | null;
      if (Array.isArray(m) && m.length === 6) ctm = Util.transform(ctm, m);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() ?? ctm;
    else if (IMAGE_OPS.has(fn)) {
      const full = Util.transform(viewport, ctm);
      const pts = [[0, 0], [1, 0], [0, 1], [1, 1]].map((p) => {
        Util.applyTransform(p, full); // in place
        return p;
      });
      const box = {
        x0: Math.max(0, Math.min(...pts.map((p) => p[0]))),
        x1: Math.min(width, Math.max(...pts.map((p) => p[0]))),
        y0: Math.max(0, Math.min(...pts.map((p) => p[1]))),
        y1: Math.min(height, Math.max(...pts.map((p) => p[1]))),
      };
      if (box.x1 - box.x0 < MIN_IMAGE_PT || box.y1 - box.y0 < MIN_IMAGE_PT) continue;
      if (boxes.some((b) => Math.abs(b.x0 - box.x0) < 1 && Math.abs(b.y0 - box.y0) < 1 && Math.abs(b.x1 - box.x1) < 1 && Math.abs(b.y1 - box.y1) < 1)) continue;
      boxes.push(box);
    }
  }
  return boxes;
}

async function pageRuns(page: PDFPageProxy): Promise<{ runs: Run[]; width: number; height: number; images: Box[] }> {
  const vp = page.getViewport({ scale: 1 });
  // Loading the operator list makes pdf.js resolve the page's fonts, which
  // is where bold/italic and the real font names come from. It also says
  // where the pictures are.
  let images: Box[] = [];
  try {
    const ops = await page.getOperatorList();
    images = imageBoxes(ops as unknown as { fnArray: number[]; argsArray: unknown[][] }, vp.transform, vp.width, vp.height);
  } catch {
    // text content can still be read
  }
  const content = await page.getTextContent();
  const runs: Run[] = [];
  const t = vp.transform;
  for (const raw of content.items) {
    const item = raw as TextItem;
    // Whitespace-only items (spaces drawn to pad table cells) would bridge the
    // gaps that separate cells and columns; word gaps are re-derived later.
    if (typeof item.str !== 'string' || !item.str.trim()) continue;
    const m = item.transform;
    // viewer-space matrix = item.transform × viewport.transform
    const a = m[0] * t[0] + m[1] * t[2];
    const b = m[0] * t[1] + m[1] * t[3];
    const c = m[2] * t[0] + m[3] * t[2];
    const d = m[2] * t[1] + m[3] * t[3];
    const e = m[4] * t[0] + m[5] * t[2] + t[4];
    const f = m[4] * t[1] + m[5] * t[3] + t[5];
    if (Math.abs(b) > Math.abs(a) * 0.1) continue; // rotated text: not part of the flow
    const size = Math.hypot(c, d) || item.height || 10;
    const scaleX = Math.hypot(a, b) / (Math.hypot(m[0], m[1]) || 1);
    const info = fontInfo(page, item.fontName, content.styles[item.fontName]);
    runs.push({
      text: item.str,
      x: e,
      y: f,
      w: item.width * (scaleX || 1),
      size,
      bold: info.bold,
      italic: info.italic,
      fontName: info.name,
      mono: info.mono,
      serif: info.serif,
    });
  }
  return { runs, width: vp.width, height: vp.height, images };
}

function buildLines(runs: Run[]): Line[] {
  const sorted = [...runs].sort((p, q) => p.y - q.y || p.x - q.x);
  const bands: Run[][] = [];
  for (const r of sorted) {
    const band = bands[bands.length - 1];
    // Superscripts/subscripts (noticeably smaller, slightly offset) stay on their line.
    const tol = band && Math.min(band[0].size, r.size) < Math.max(band[0].size, r.size) * 0.8 ? 0.6 : 0.4;
    if (band && Math.abs(band[0].y - r.y) < Math.max(band[0].size, r.size) * tol) band.push(r);
    else bands.push([r]);
  }
  return bands.map((band) => {
    band.sort((p, q) => p.x - q.x);
    const size = median(band.map((r) => r.size));
    const split = (maxGap: number) => {
      const segments: Segment[] = [];
      for (const r of band) {
        const seg = segments[segments.length - 1];
        if (seg && r.x - seg.x1 < size * maxGap) {
          seg.runs.push(r);
          seg.x1 = Math.max(seg.x1, r.x + r.w);
        } else {
          segments.push({ runs: [r], x0: r.x, x1: r.x + r.w, y: r.y, size });
        }
      }
      segments.forEach((s) => (s.size = median(s.runs.map((r) => r.size))));
      return segments;
    };
    return { segments: split(1.6), fine: split(0.5), y: median(band.map((r) => r.y)), size };
  });
}

function segmentRuns(seg: Segment): StyledRun[] {
  const out: StyledRun[] = [];
  let prevEnd: number | null = null;
  for (const r of seg.runs) {
    let text = r.text;
    if (prevEnd !== null && r.x - prevEnd > r.size * 0.15 && !/\s$/.test(out[out.length - 1]?.text ?? '') && !/^\s/.test(text)) text = ' ' + text;
    const last = out[out.length - 1];
    if (last && last.bold === r.bold && last.italic === r.italic && Math.abs(last.size - r.size) < 0.5 && last.fontName === r.fontName) last.text += text;
    else out.push({ text, bold: r.bold, italic: r.italic, size: r.size, fontName: r.fontName, mono: r.mono, serif: r.serif });
    prevEnd = Math.max(prevEnd ?? -Infinity, r.x + r.w);
  }
  return out;
}

const runsText = (runs: StyledRun[]) => runs.map((r) => r.text).join('').replace(/\s+/g, ' ').trim();

// ------------------------------------------------------------------ tables

interface Span {
  x0: number;
  x1: number;
}

interface TableCandidate {
  lines: Line[];
  /** Each line's cells (segments). */
  cells: Segment[][];
  columns: Span[];
}

/**
 * A cell belongs to a column if it overlaps the column's horizontal extent,
 * or shares its left or right edge — so left-aligned text, right-aligned
 * numbers and centred headers all line up.
 */
function inColumn(s: Span, c: Span, tol: number): boolean {
  return Math.min(s.x1, c.x1) - Math.max(s.x0, c.x0) > 0 || Math.abs(s.x0 - c.x0) < tol || Math.abs(s.x1 - c.x1) < tol;
}

/** Columns that came to overlap as cells were added are one column. */
function mergeColumns(cols: Span[]): Span[] {
  const sorted = [...cols].sort((a, b) => a.x0 - b.x0);
  const out: Span[] = [];
  for (const c of sorted) {
    const last = out[out.length - 1];
    if (last && c.x0 < last.x1) last.x1 = Math.max(last.x1, c.x1);
    else out.push({ ...c });
  }
  return out;
}

/**
 * Groups of consecutive lines whose cells line up in columns. `strict` is the
 * second pass over finely split lines (tight tables): it needs at least three
 * rows and three columns of short cells, so prose is never cut into cells.
 */
function detectTables(lines: Line[], strict = false): { tables: TableCandidate[]; used: Set<Line> } {
  const tables: TableCandidate[] = [];
  const used = new Set<Line>();
  const segsOf = (l: Line) => (strict ? l.fine : l.segments);
  const minCells = strict ? 3 : 2;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (segsOf(line).length < minCells) {
      i++;
      continue;
    }
    const group: Line[] = [line];
    let cols: Span[] = mergeColumns(segsOf(line).map((s) => ({ x0: s.x0, x1: s.x1 })));
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      const segs = segsOf(next);
      const gap = next.y - group[group.length - 1].y;
      if (gap > Math.max(next.size, line.size) * 3) break;
      if (segs.length < minCells) break;
      const tol = next.size * 0.8;
      const hits = segs.map((s) => cols.findIndex((c) => inColumn(s, c, tol)));
      const distinct = new Set(hits.filter((h) => h >= 0)).size;
      if (distinct < Math.min(strict ? 3 : 2, segs.length)) break;
      group.push(next);
      cols = mergeColumns([...cols, ...segs.map((s) => ({ x0: s.x0, x1: s.x1 }))]);
      j++;
    }
    const cellWords = group.flatMap((l) => segsOf(l).map((s) => runsText(segmentRuns(s)).split(' ').length));
    const avgWords = cellWords.reduce((a, b) => a + b, 0) / Math.max(1, cellWords.length);
    // Two-column body text also yields aligned multi-segment lines; real
    // table cells are short. Two side-by-side columns of short phrases look
    // like a 2-column table; without numbers, treat them as text columns.
    const hasNumbers = group.some((l) => segsOf(l).some((s) => /^[\s$€£¥₹%()+\-.,\d]+$/.test(runsText(segmentRuns(s)))));
    const proseColumns = cols.length === 2 && avgWords > 3 && !hasNumbers;
    const ok = strict ? group.length >= 3 && cols.length >= 3 && avgWords <= 3 : group.length >= 2 && avgWords <= 6 && !proseColumns;
    if (ok) {
      tables.push({ lines: group, cells: group.map(segsOf), columns: cols });
      group.forEach((l) => used.add(l));
      i = j;
    } else {
      i++;
    }
  }
  return { tables, used };
}

function tableRows(t: TableCandidate): string[][] {
  const cols = t.columns;
  return t.cells.map((segs) => {
    const row = new Array(cols.length).fill('');
    for (const seg of segs) {
      // The column it overlaps most; else the nearest.
      let best = 0;
      let bestScore = -Infinity;
      cols.forEach((c, k) => {
        const overlap = Math.min(seg.x1, c.x1) - Math.max(seg.x0, c.x0);
        const score = overlap > 0 ? overlap : -Math.abs((seg.x0 + seg.x1) / 2 - (c.x0 + c.x1) / 2);
        if (score > bestScore) {
          bestScore = score;
          best = k;
        }
      });
      row[best] = (row[best] ? row[best] + ' ' : '') + runsText(segmentRuns(seg));
    }
    return row;
  });
}

// ------------------------------------------------------------------ blocks

interface RawBlock {
  segs: Segment[];
  box: Box;
}

function buildBlocks(segs: Segment[]): RawBlock[] {
  const sorted = [...segs].sort((a, b) => a.y - b.y || a.x0 - b.x0);
  const blocks: RawBlock[] = [];
  const isBullet = (seg: Segment) => BULLET_RE.test(runsText(segmentRuns(seg)));
  for (const s of sorted) {
    const bullet = isBullet(s);
    let best: RawBlock | null = null;
    let bestDy = Infinity;
    for (const b of blocks) {
      const last = b.segs[b.segs.length - 1];
      const dy = s.y - last.y;
      const size = Math.max(s.size, last.size);
      if (dy < size * 0.5 || dy > size * 1.8) continue;
      if (Math.abs(s.size - last.size) > size * 0.18) continue;
      const overlap = Math.min(s.x1, b.box.x1) - Math.max(s.x0, b.box.x0);
      if (overlap < Math.min(s.x1 - s.x0, b.box.x1 - b.box.x0) * 0.3) continue;
      const listBlock = isBullet(b.segs[0]);
      // Bullets only continue lists; inside a list, plain lines must be
      // indented continuation lines rather than a new paragraph.
      if (bullet && !listBlock) continue;
      if (!bullet && listBlock && s.x0 < b.segs[0].x0 + s.size * 0.5) continue;
      if (dy < bestDy) {
        best = b;
        bestDy = dy;
      }
    }
    if (best) {
      best.segs.push(s);
      best.box = { x0: Math.min(best.box.x0, s.x0), x1: Math.max(best.box.x1, s.x1), y0: best.box.y0, y1: s.y + s.size * 0.25 };
    } else {
      blocks.push({ segs: [s], box: { x0: s.x0, x1: s.x1, y0: s.y - s.size, y1: s.y + s.size * 0.25 } });
    }
  }
  return blocks;
}

/** Recursive XY-cut reading order over block boxes. */
function readingOrder<T extends { box: Box }>(items: T[], unit: number): T[] {
  if (items.length <= 1) return items;
  const cut = (axis: 'x' | 'y'): T[][] | null => {
    const lo = axis === 'x' ? 'x0' : 'y0';
    const hi = axis === 'x' ? 'x1' : 'y1';
    const sorted = [...items].sort((a, b) => a.box[lo] - b.box[lo]);
    const groups: T[][] = [[sorted[0]]];
    let reach = sorted[0].box[hi];
    let widest = 0;
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i].box[lo] - reach;
      if (gap > (axis === 'x' ? unit * 1.2 : unit * 0.2)) {
        groups.push([sorted[i]]);
        widest = Math.max(widest, gap);
      } else {
        groups[groups.length - 1].push(sorted[i]);
      }
      reach = Math.max(reach, sorted[i].box[hi]);
    }
    return groups.length > 1 ? groups : null;
  };
  const rows = cut('y');
  if (rows) return rows.flatMap((g) => readingOrder(g, unit));
  const cols = cut('x');
  if (cols) return cols.flatMap((g) => readingOrder(g, unit));
  return [...items].sort((a, b) => a.box.y0 - b.box.y0 || a.box.x0 - b.box.x0);
}

function joinBlockRuns(segs: Segment[]): StyledRun[] {
  const out: StyledRun[] = [];
  segs.forEach((s, i) => {
    const runs = segmentRuns(s);
    if (i > 0 && out.length) {
      const last = out[out.length - 1];
      if (/[A-Za-z]-$/.test(last.text) && /^[a-z]/.test(runs[0]?.text ?? '')) last.text = last.text.slice(0, -1);
      else if (!/\s$/.test(last.text)) last.text += ' ';
    }
    for (const r of runs) {
      const last = out[out.length - 1];
      if (last && last.bold === r.bold && last.italic === r.italic && Math.abs(last.size - r.size) < 0.5) last.text += r.text;
      else out.push({ ...r });
    }
  });
  return out;
}

export async function analyzeDocumentLayout(doc: PDFDocumentProxy, onProgress?: (page: number, total: number) => void): Promise<PageLayout[]> {
  interface PageWork {
    pageNumber: number;
    width: number;
    height: number;
    lines: Line[];
    tables: TableCandidate[];
    blocks: RawBlock[];
    images: Box[];
  }
  const work: PageWork[] = [];
  const allSizes: number[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { runs, width, height, images } = await pageRuns(page);
    page.cleanup();
    const lines = buildLines(runs);
    const { tables, used } = detectTables(lines);
    // Second pass for tables set so tightly that their cells look like words of one line.
    const tight = detectTables(lines.filter((l) => !used.has(l)), true);
    tables.push(...tight.tables);
    tight.used.forEach((l) => used.add(l));
    const segs = lines.filter((l) => !used.has(l)).flatMap((l) => l.segments);
    const blocks = buildBlocks(segs);
    runs.forEach((r) => {
      for (let k = 0; k < Math.min(r.text.length, 20); k++) allSizes.push(Math.round(r.size * 2) / 2);
    });
    work.push({ pageNumber: p, width, height, lines, tables, blocks, images });
    onProgress?.(p, doc.numPages);
  }

  const body = median(allSizes) || 11;
  const headingSizes = [...new Set(work.flatMap((w) => w.blocks.map((b) => Math.round(median(b.segs.map((s) => s.size)) * 2) / 2)).filter((s) => s >= body * 1.15))].sort((a, b) => b - a);
  const levelOf = (size: number): 1 | 2 | 3 => {
    const idx = headingSizes.findIndex((s) => Math.abs(s - size) < 0.6);
    return (Math.min(3, Math.max(1, idx + 1)) as 1 | 2 | 3);
  };

  return work.map((w) => {
    const items: Array<{ box: Box; block: LayoutBlock }> = [];
    for (const box of w.images) items.push({ box, block: { kind: 'image', box } });
    for (const t of w.tables) {
      const ys = t.lines.map((l) => l.y);
      const xs = t.cells.flatMap((segs) => segs.flatMap((s) => [s.x0, s.x1]));
      items.push({
        box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys) - t.lines[0].size, y1: Math.max(...ys) + 2 },
        block: { kind: 'table', rows: tableRows(t), box: { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) } },
      });
    }
    for (const b of w.blocks) {
      const runs = joinBlockRuns(b.segs);
      const text = runsText(runs);
      if (!text) continue;
      const size = median(b.segs.map((s) => s.size));
      const allBold = runs.every((r) => r.bold || !r.text.trim());
      const firstText = runsText(segmentRuns(b.segs[0]));
      if (BULLET_RE.test(firstText)) {
        const listItems: Array<{ runs: StyledRun[]; text: string; marker: string }> = [];
        let cur: Segment[] = [];
        const flush = () => {
          if (!cur.length) return;
          const r = joinBlockRuns(cur);
          const t = runsText(r);
          const marker = (t.match(BULLET_RE)?.[1] ?? '').trim();
          const stripped = r.map((x) => ({ ...x }));
          // remove the marker from the first run(s)
          let toStrip = (t.match(BULLET_RE)?.[0] ?? '').length;
          for (const x of stripped) {
            const lead = x.text.length - x.text.trimStart().length;
            if (toStrip <= 0) break;
            const cut = Math.min(x.text.length, toStrip + lead);
            toStrip -= cut - lead;
            x.text = x.text.slice(cut);
          }
          listItems.push({ runs: stripped.filter((x) => x.text), text: t.replace(BULLET_RE, ''), marker });
          cur = [];
        };
        for (const s of b.segs) {
          if (BULLET_RE.test(runsText(segmentRuns(s)))) flush();
          cur.push(s);
        }
        flush();
        const ordered = listItems.every((it) => /\d|^[a-zA-Z]$|^[ivxIVX]+$/.test(it.marker.replace(/[.()]/g, '')));
        items.push({ box: b.box, block: { kind: 'list', ordered, items: listItems, box: b.box } });
        continue;
      }
      const isHeading =
        b.segs.length <= 3 &&
        text.length < 160 &&
        !/[.:;,]$/.test(text) &&
        (size >= body * 1.15 || (allBold && size >= body * 0.95 && text.length < 90 && b.segs.length <= 2));
      if (isHeading) {
        items.push({ box: b.box, block: { kind: 'heading', level: size >= body * 1.15 ? levelOf(size) : 3, runs, text, box: b.box } });
        continue;
      }
      let align: 'left' | 'center' | 'right' | 'justify' = 'left';
      if (b.segs.length > 2) {
        const lefts = b.segs.slice(1).map((s) => s.x0);
        const rights = b.segs.slice(0, -1).map((s) => s.x1);
        const spread = (v: number[]) => Math.max(...v) - Math.min(...v);
        if (spread(lefts) < size && spread(rights) < size) align = 'justify';
        else if (spread(b.segs.map((s) => (s.x0 + s.x1) / 2)) < size && spread(lefts) > size) align = 'center';
      } else if (b.segs.length === 1) {
        const cx = (b.box.x0 + b.box.x1) / 2;
        if (Math.abs(cx - w.width / 2) < w.width * 0.05 && b.box.x0 > w.width * 0.2) align = 'center';
        else if (b.box.x1 > w.width * 0.85 && b.box.x0 > w.width * 0.5) align = 'right';
      }
      items.push({ box: b.box, block: { kind: 'paragraph', runs, text, box: b.box, align } });
    }
    const ordered = readingOrder(items, body);
    const lines: LayoutLineOut[] = w.lines.flatMap((l) =>
      l.segments.map((s) => {
        const runs = segmentRuns(s);
        return { runs, text: runsText(runs), x0: s.x0, x1: s.x1, y: s.y, size: s.size };
      })
    );
    return { pageNumber: w.pageNumber, width: w.width, height: w.height, blocks: ordered.map((o) => o.block), lines };
  });
}
