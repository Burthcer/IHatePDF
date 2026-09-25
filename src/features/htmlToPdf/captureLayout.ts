/**
 * Captures the browser's own layout of an HTML document (rendered in an
 * iframe at the page's content width) as a display list — positioned words,
 * boxes, borders and images — split into pages at gaps between lines so no
 * line of text is cut in half. The worker then draws it with real,
 * selectable PDF text.
 */

import type { HtmlDisplayItem, HtmlPage } from '../../types/worker';

const PX_TO_PT = 72 / 96;

interface Capture {
  pages: HtmlPage[];
  images: ArrayBuffer[];
}

function parseColor(value: string): { hex: string; alpha: number } | null {
  const m = value.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
  const [r, g, b] = parts;
  const alpha = parts.length > 3 ? parts[3] : 1;
  if (alpha === 0) return null;
  const hex = '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  return { hex, alpha };
}

function familyOf(css: string): 'sans' | 'serif' | 'mono' {
  const f = css.toLowerCase();
  if (/mono|courier|consolas|menlo/.test(f)) return 'mono';
  const first = f.split(',')[0];
  if (/serif/.test(first) && !/sans/.test(first)) return 'serif';
  if (/times|georgia|garamond|palatino|cambria|book/.test(first)) return 'serif';
  return 'sans';
}

async function imageToPng(img: HTMLImageElement): Promise<ArrayBuffer | null> {
  try {
    if (!img.complete) await img.decode();
    const w = img.naturalWidth || img.width;
    const h = img.naturalHeight || img.height;
    if (!w || !h) return null;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    c.getContext('2d')!.drawImage(img, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    return blob ? await blob.arrayBuffer() : null;
  } catch {
    return null; // cross-origin or broken image
  }
}

interface Raw {
  top: number;
  bottom: number;
  item: HtmlDisplayItem;
  isText: boolean;
}

export async function captureLayout(
  frame: HTMLIFrameElement,
  opts: { pageWidthPt: number; pageHeightPt: number; marginPt: number }
): Promise<Capture> {
  const doc = frame.contentDocument!;
  const win = frame.contentWindow!;
  await doc.fonts?.ready;
  const k = PX_TO_PT;
  const raws: Raw[] = [];
  const images: ArrayBuffer[] = [];
  const forcedBreaks: number[] = [];
  const scrollY = win.scrollY;
  const scrollX = win.scrollX;

  const walk = async (el: Element) => {
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return;
    const r = el.getBoundingClientRect();
    const top = r.top + scrollY;
    const left = r.left + scrollX;

    if (cs.breakBefore === 'page' || (cs as unknown as Record<string, string>).pageBreakBefore === 'always') forcedBreaks.push(top);

    const bg = parseColor(cs.backgroundColor);
    if (bg && r.width > 0 && r.height > 0 && el !== doc.body && el !== doc.documentElement) {
      raws.push({ top, bottom: top + r.height, isText: false, item: { t: 'rect', x: left * k, y: top * k, w: r.width * k, h: r.height * k, fill: bg.hex, opacity: bg.alpha } });
    }
    (['Top', 'Right', 'Bottom', 'Left'] as const).forEach((side) => {
      const width = parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`));
      const style = cs.getPropertyValue(`border-${side.toLowerCase()}-style`);
      const color = parseColor(cs.getPropertyValue(`border-${side.toLowerCase()}-color`));
      if (!width || style === 'none' || style === 'hidden' || !color) return;
      const x1 = side === 'Right' ? left + r.width - width / 2 : left + (side === 'Left' ? width / 2 : 0);
      const y1 = side === 'Bottom' ? top + r.height - width / 2 : top + (side === 'Top' ? width / 2 : 0);
      const x2 = side === 'Top' || side === 'Bottom' ? left + r.width : x1;
      const y2 = side === 'Left' || side === 'Right' ? top + r.height : y1;
      raws.push({ top: Math.min(y1, y2), bottom: Math.max(y1, y2), isText: false, item: { t: 'line', x1: x1 * k, y1: y1 * k, x2: x2 * k, y2: y2 * k, width: width * k, color: color.hex, dashed: style === 'dashed' || style === 'dotted' } });
    });

    if (el.tagName === 'IMG') {
      const png = await imageToPng(el as HTMLImageElement);
      if (png && r.width > 0) {
        images.push(png);
        raws.push({ top, bottom: top + r.height, isText: false, item: { t: 'image', x: left * k, y: top * k, w: r.width * k, h: r.height * k, index: images.length - 1 } });
      }
      return;
    }
    if (el.tagName === 'HR' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;

    // list markers aren't in the DOM; draw them ourselves
    if (el.tagName === 'LI' && cs.listStyleType !== 'none') {
      const parent = el.parentElement;
      const ordered = parent?.tagName === 'OL' || /decimal|alpha|roman/.test(cs.listStyleType);
      const index = parent ? Array.from(parent.children).filter((c) => c.tagName === 'LI').indexOf(el) : 0;
      const start = parent?.tagName === 'OL' ? Number((parent as HTMLOListElement).start || 1) : 1;
      const marker = ordered ? `${start + index}.` : cs.listStyleType === 'circle' ? '◦' : cs.listStyleType === 'square' ? '▪' : '•';
      const size = parseFloat(cs.fontSize);
      const firstLine = (() => {
        const range = doc.createRange();
        range.selectNodeContents(el);
        return range.getClientRects()[0];
      })();
      const baseTop = (firstLine ? firstLine.top : r.top) + scrollY;
      const lineH = firstLine ? firstLine.height : size * 1.2;
      raws.push({
        top: baseTop,
        bottom: baseTop + lineH,
        isText: true,
        item: { t: 'text', x: (left - size * (ordered ? 1.6 : 1.1)) * k, y: (baseTop + lineH - (lineH - size) / 2 - size * 0.22) * k, text: marker, size: size * k, family: familyOf(cs.fontFamily), bold: false, italic: false, color: parseColor(cs.color)?.hex ?? '#000000' },
      });
    }

    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = node.textContent ?? '';
        if (!text.trim()) continue;
        const size = parseFloat(cs.fontSize);
        const bold = (parseInt(cs.fontWeight, 10) || 400) >= 600;
        const italic = cs.fontStyle === 'italic' || cs.fontStyle === 'oblique';
        const color = parseColor(cs.color)?.hex ?? '#000000';
        const family = familyOf(cs.fontFamily);
        const underline = cs.textDecorationLine.includes('underline');
        const strike = cs.textDecorationLine.includes('line-through');
        const pre = /^pre/.test(cs.whiteSpace);
        const re = pre ? /[^\n]+/g : /\S+/g;
        let m: RegExpExecArray | null;
        const range = doc.createRange();
        while ((m = re.exec(text))) {
          range.setStart(node, m.index);
          range.setEnd(node, m.index + m[0].length);
          // a "word" can still wrap (e.g. long URLs): take each rect separately
          const rects = Array.from(range.getClientRects()).filter((rc) => rc.width > 0);
          if (!rects.length) continue;
          const word = cs.textTransform === 'uppercase' ? m[0].toUpperCase() : cs.textTransform === 'lowercase' ? m[0].toLowerCase() : m[0];
          if (rects.length === 1) {
            const rc = rects[0];
            const top2 = rc.top + scrollY;
            const baseline = rc.bottom + scrollY - (rc.height - size) / 2 - size * 0.22;
            raws.push({ top: top2, bottom: top2 + rc.height, isText: true, item: { t: 'text', x: (rc.left + scrollX) * k, y: baseline * k, text: word, size: size * k, family, bold, italic, color } });
            if (underline || strike) {
              const ly = strike ? baseline - size * 0.3 : baseline + size * 0.12;
              raws.push({ top: top2, bottom: top2 + rc.height, isText: false, item: { t: 'line', x1: (rc.left + scrollX) * k, y1: ly * k, x2: (rc.right + scrollX) * k, y2: ly * k, width: Math.max(0.5, size / 16) * k, color, dashed: false } });
            }
          } else {
            // split the word by character to match each rect
            let pos = m.index;
            for (const rc of rects) {
              let end = pos + 1;
              while (end < m.index + m[0].length) {
                range.setStart(node, pos);
                range.setEnd(node, end + 1);
                const rr = range.getClientRects();
                if (rr.length > 1 || (rr[0] && rr[0].right > rc.right + 1)) break;
                end++;
              }
              const piece = text.slice(pos, end);
              const top2 = rc.top + scrollY;
              const baseline = rc.bottom + scrollY - (rc.height - size) / 2 - size * 0.22;
              raws.push({ top: top2, bottom: top2 + rc.height, isText: true, item: { t: 'text', x: (rc.left + scrollX) * k, y: baseline * k, text: piece, size: size * k, family, bold, italic, color } });
              pos = end;
            }
          }
        }
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        await walk(node as Element);
      }
    }
  };

  await walk(doc.body);

  // ---- pagination (pt, content area) at gaps between lines of text
  const contentH = (opts.pageHeightPt - opts.marginPt * 2) / k; // in px
  const textSpans = raws.filter((r) => r.isText).map((r) => [r.top, r.bottom] as const);
  const docBottom = Math.max(doc.documentElement.scrollHeight, ...raws.map((r) => r.bottom), 1);
  const breaks: number[] = [0];
  const forced = [...new Set(forcedBreaks.map((b) => Math.round(b)))].filter((b) => b > 1).sort((a, b) => a - b);
  let start = 0;
  while (start + contentH < docBottom || forced.some((f) => f > start + 1)) {
    const nextForced = forced.find((f) => f > start + 1);
    let target = start + contentH;
    if (nextForced !== undefined && nextForced <= target) {
      target = nextForced;
    } else {
      // move the break up to a point no line of text crosses
      let y = target;
      for (let guard = 0; guard < 200; guard++) {
        const crossing = textSpans.find(([t, b]) => t < y - 0.5 && b > y + 0.5);
        if (!crossing) break;
        y = crossing[0] - 0.5;
      }
      if (y > start + contentH * 0.3) target = y;
    }
    breaks.push(target);
    start = target;
    if (breaks.length > 2000) break;
  }
  breaks.push(Math.max(docBottom, start + 1));

  const pages: HtmlPage[] = [];
  for (let p = 0; p < breaks.length - 1; p++) {
    const top = breaks[p];
    const bottom = breaks[p + 1];
    if (bottom - top < 1) continue;
    const items: HtmlDisplayItem[] = [];
    const dy = -top * k + opts.marginPt;
    const dx = opts.marginPt;
    for (const r of raws) {
      if (r.bottom <= top || r.top >= bottom) continue;
      if (r.isText && r.top < top - 0.5) continue; // belongs to previous page
      const it = r.item;
      switch (it.t) {
        case 'text':
          items.push({ ...it, x: it.x + dx, y: it.y + dy });
          break;
        case 'rect': {
          const y0 = Math.max(it.y, top * k);
          const y1 = Math.min(it.y + it.h, bottom * k);
          items.push({ ...it, x: it.x + dx, y: y0 + dy, h: y1 - y0 });
          break;
        }
        case 'line':
          items.push({ ...it, x1: it.x1 + dx, x2: it.x2 + dx, y1: Math.max(it.y1, top * k) + dy, y2: Math.min(it.y2, bottom * k) + dy });
          break;
        case 'image':
          if (r.top >= top - 0.5) items.push({ ...it, x: it.x + dx, y: it.y + dy });
          break;
      }
    }
    // backgrounds first, then lines/images, then text
    const order = { rect: 0, image: 1, line: 2, text: 3 } as const;
    items.sort((a, b) => order[a.t] - order[b.t]);
    pages.push({ items });
  }
  if (!pages.length) pages.push({ items: [] });
  return { pages, images };
}
