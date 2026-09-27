/**
 * Page-range strings like "1-3, 5, 8-" (1-based, inclusive). An open end
 * means "to the last page", an open start "from the first page".
 */

export interface PageRange {
  from: number;
  to: number;
}

export function parsePageRanges(input: string, maxPage: number): PageRange[] {
  const tokens = input
    .split(/[,;]/)
    .map((t) => t.trim())
    .filter(Boolean);
  if (tokens.length === 0) throw new Error('Enter at least one page or range, e.g. “1-3, 5, 8-”.');
  const ranges: PageRange[] = [];
  for (const token of tokens) {
    const m = token.match(/^(\d*)\s*(?:(-|–|to)\s*(\d*))?$/i);
    if (!m || (!m[1] && !m[3])) throw new Error(`“${token}” isn’t a page number or range.`);
    const from = m[1] ? parseInt(m[1], 10) : 1;
    const to = m[2] ? (m[3] ? parseInt(m[3], 10) : maxPage) : from;
    if (from < 1 || to < 1 || from > maxPage || to > maxPage) throw new Error(`“${token}” is outside this ${maxPage}-page document.`);
    if (from > to) throw new Error(`“${token}” runs backwards.`);
    ranges.push({ from, to });
  }
  return ranges;
}

/** Compact string for a set of 1-based pages: [1,2,3,5] → "1-3, 5". */
export function formatPageSet(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    parts.push(start === sorted[i] ? String(start) : `${start}-${sorted[i]}`);
  }
  return parts.join(', ');
}

export function rangesToPages(ranges: PageRange[]): number[] {
  const out: number[] = [];
  for (const r of ranges) for (let p = r.from; p <= r.to; p++) out.push(p);
  return out;
}
