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
  | { kind: 'table'; rows: string[][]; box: Box };

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
  segments: Segment[];
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

async function pageRuns(page: PDFPageProxy): Promise<{ runs: Run[]; width: number; height: number }> {
  const vp = page.getViewport({ scale: 1 });
  // Loading the operator list makes pdf.js resolve the page's fonts, which
  // is where bold/italic and the real font names come from.
  try {
    await page.getOperatorList();
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
  return { runs, width: vp.width, height: vp.height };
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
    const segments: Segment[] = [];
    for (const r of band) {
      const seg = segments[segments.length - 1];
      if (seg && r.x - seg.x1 < size * 1.6) {
        seg.runs.push(r);
        seg.x1 = Math.max(seg.x1, r.x + r.w);
      } else {
        segments.push({ runs: [r], x0: r.x, x1: r.x + r.w, y: r.y, size });
      }
    }
    segments.forEach((s) => (s.size = median(s.runs.map((r) => r.size))));
    return { segments, y: median(band.map((r) => r.y)), size };
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

interface TableCandidate {
  lines: Line[];
  columns: number[];
}

function detectTables(lines: Line[]): { tables: TableCandidate[]; used: Set<Line> } {
  const tables: TableCandidate[] = [];
  const used = new Set<Line>();
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.segments.length < 2) {
      i++;
      continue;
    }
    const group: Line[] = [line];
    let cols = line.segments.map((s) => s.x0);
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      const gap = next.y - group[group.length - 1].y;
      if (gap > Math.max(next.size, line.size) * 3) break;
      if (next.segments.length < 2) break;
      const tol = next.size * 1.2;
      const matched = next.segments.filter((s) => cols.some((c) => Math.abs(c - s.x0) < tol)).length;
      if (matched < Math.min(2, next.segments.length)) break;
      group.push(next);
      next.segments.forEach((s) => {
        if (!cols.some((c) => Math.abs(c - s.x0) < tol)) cols.push(s.x0);
      });
      cols = cols.sort((a, b) => a - b);
      j++;
    }
    // Two-column body text also yields aligned multi-segment lines; real
    // table cells are short, so reject groups of wordy "cells".
    const cellWords = group.flatMap((l) => l.segments.map((s) => runsText(segmentRuns(s)).split(' ').length));
    const avgWords = cellWords.reduce((a, b) => a + b, 0) / Math.max(1, cellWords.length);
    // Two side-by-side columns of short phrases look like a 2-column table;
    // without numbers or single-word labels, treat them as text columns.
    const hasNumbers = group.some((l) => l.segments.some((s) => /^[\s$€£¥%()+\-.,\d]+$/.test(runsText(segmentRuns(s)))));
    const proseColumns = cols.length === 2 && avgWords > 3 && !hasNumbers;
    if (group.length >= 2 && avgWords <= 6 && !proseColumns) {
      tables.push({ lines: group, columns: cols });
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
  return t.lines.map((line) => {
    const row = new Array(cols.length).fill('');
    for (const seg of line.segments) {
      let best = 0;
      let bestD = Infinity;
      cols.forEach((c, k) => {
        const d = Math.abs(c - seg.x0);
        if (d < bestD) {
          bestD = d;
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
  }
  const work: PageWork[] = [];
  const allSizes: number[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { runs, width, height } = await pageRuns(page);
    page.cleanup();
    const lines = buildLines(runs);
    const { tables, used } = detectTables(lines);
    const segs = lines.filter((l) => !used.has(l)).flatMap((l) => l.segments);
    const blocks = buildBlocks(segs);
    runs.forEach((r) => {
      for (let k = 0; k < Math.min(r.text.length, 20); k++) allSizes.push(Math.round(r.size * 2) / 2);
    });
    work.push({ pageNumber: p, width, height, lines, tables, blocks });
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
    for (const t of w.tables) {
      const ys = t.lines.map((l) => l.y);
      const xs = t.lines.flatMap((l) => l.segments.flatMap((s) => [s.x0, s.x1]));
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
