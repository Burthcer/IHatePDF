/**
 * Shared positioning helpers for stamping text/images onto PDF pages
 * (Watermark, Page Numbers) — IHatePDF
 */

import type { WatermarkPosition } from '../types/worker';

export function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace('#', '');
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const num = parseInt(full, 16);
  return {
    r: ((num >> 16) & 0xff) / 255,
    g: ((num >> 8) & 0xff) / 255,
    b: (num & 0xff) / 255,
  };
}

/**
 * Anchor point (bottom-left of the content box, in PDF points) for placing
 * a `contentWidth` x `contentHeight` box on a `pageWidth` x `pageHeight`
 * page at one of the 9 grid positions, inset by `margin` points.
 */
export function computeAnchor(
  pageWidth: number,
  pageHeight: number,
  contentWidth: number,
  contentHeight: number,
  position: WatermarkPosition,
  margin: number
): { x: number; y: number } {
  let x: number;
  if (position.endsWith('left')) x = margin;
  else if (position.endsWith('right')) x = pageWidth - contentWidth - margin;
  else x = (pageWidth - contentWidth) / 2;

  let y: number;
  if (position.startsWith('top')) y = pageHeight - contentHeight - margin;
  else if (position.startsWith('bottom')) y = margin;
  else y = (pageHeight - contentHeight) / 2;

  return { x, y };
}

const ROMAN_TABLE: Array<[number, string]> = [
  [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'],
  [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'],
  [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
];

export function toRoman(n: number): string {
  let remaining = Math.max(1, Math.round(n));
  let out = '';
  for (const [value, symbol] of ROMAN_TABLE) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out;
}

/**
 * Origin for drawing a w×h box rotated by `degrees` (counter-clockwise,
 * pdf-lib convention, rotating about the origin) so that its rotated
 * bounding box sits at `position` with `margin` — i.e. the box turns about
 * its own center instead of swinging off its bottom-left corner.
 */
export function rotatedPlacement(
  pageWidth: number,
  pageHeight: number,
  w: number,
  h: number,
  degrees: number,
  position: WatermarkPosition,
  margin: number
): { x: number; y: number } {
  const t = (degrees * Math.PI) / 180;
  const cos = Math.cos(t);
  const sin = Math.sin(t);
  const bw = Math.abs(w * cos) + Math.abs(h * sin);
  const bh = Math.abs(w * sin) + Math.abs(h * cos);
  const anchor = computeAnchor(pageWidth, pageHeight, bw, bh, position, margin);
  const cx = anchor.x + bw / 2;
  const cy = anchor.y + bh / 2;
  return { x: cx - ((w / 2) * cos - (h / 2) * sin), y: cy - ((w / 2) * sin + (h / 2) * cos) };
}
