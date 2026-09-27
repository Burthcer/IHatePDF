/**
 * 2D affine matrices in PDF convention: [a b c d e f], points are row vectors,
 * so `multiply(m, n)` means "apply m, then n".
 */

import { PDFArray, PDFName, PDFNumber, type PDFPage } from 'pdf-lib';

export type Matrix = [number, number, number, number, number, number];

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [...IDENTITY];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(m[4] * a + m[5] * c), -(m[4] * b + m[5] * d)];
}

export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Applies only the linear part (for direction vectors). */
export function applyVector(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y, m[1] * x + m[3] * y];
}

export function translate(x: number, y: number): Matrix {
  return [1, 0, 0, 1, x, y];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function readBox(page: PDFPage, key: string): [number, number, number, number] | null {
  const raw = page.node.lookup(PDFName.of(key));
  // Boxes are inheritable; pdf-lib's getMediaBox/getCropBox already handle
  // that, this is only a fallback for odd values.
  if (raw instanceof PDFArray && raw.size() === 4) {
    const vals = [0, 1, 2, 3].map((i) => {
      const v = raw.lookup(i);
      return v instanceof PDFNumber ? v.asNumber() : 0;
    });
    return [Math.min(vals[0], vals[2]), Math.min(vals[1], vals[3]), Math.max(vals[0], vals[2]), Math.max(vals[1], vals[3])];
  }
  return null;
}

/**
 * The page region a viewer actually shows: CropBox ∩ MediaBox, as
 * [x0, y0, x1, y1] in user space. Mirrors pdf.js's `view`.
 */
export function visibleBox(page: PDFPage): [number, number, number, number] {
  const mb = page.getMediaBox();
  const media: [number, number, number, number] = [
    Math.min(mb.x, mb.x + mb.width),
    Math.min(mb.y, mb.y + mb.height),
    Math.max(mb.x, mb.x + mb.width),
    Math.max(mb.y, mb.y + mb.height),
  ];
  let crop: [number, number, number, number] | null = null;
  try {
    const cb = page.getCropBox();
    crop = [Math.min(cb.x, cb.x + cb.width), Math.min(cb.y, cb.y + cb.height), Math.max(cb.x, cb.x + cb.width), Math.max(cb.y, cb.y + cb.height)];
  } catch {
    crop = readBox(page, 'CropBox');
  }
  if (!crop) return media;
  const x0 = Math.max(media[0], crop[0]);
  const y0 = Math.max(media[1], crop[1]);
  const x1 = Math.min(media[2], crop[2]);
  const y1 = Math.min(media[3], crop[3]);
  if (x1 - x0 < 1 || y1 - y0 < 1) return media;
  return [x0, y0, x1, y1];
}

export function pageRotation(page: PDFPage): number {
  const r = page.getRotation().angle % 360;
  const norm = ((Math.round(r / 90) * 90) % 360 + 360) % 360;
  return norm;
}

/**
 * User space → viewer space at scale 1: origin at the top-left of the page
 * as displayed (after /Rotate and cropping), y pointing down, units in
 * points. Same transform pdf.js's PageViewport computes, so overlay
 * coordinates line up with pdf.js renders exactly.
 */
export function userToViewer(page: PDFPage): { matrix: Matrix; width: number; height: number } {
  const [x0, y0, x1, y1] = visibleBox(page);
  const rotation = pageRotation(page);
  let ra: number, rb: number, rc: number, rd: number;
  switch (rotation) {
    case 180: ra = -1; rb = 0; rc = 0; rd = 1; break;
    case 90: ra = 0; rb = 1; rc = 1; rd = 0; break;
    case 270: ra = 0; rb = -1; rc = -1; rd = 0; break;
    default: ra = 1; rb = 0; rc = 0; rd = -1; break;
  }
  const cx = (x1 + x0) / 2;
  const cy = (y1 + y0) / 2;
  let offX: number, offY: number, width: number, height: number;
  if (ra === 0) {
    offX = Math.abs(cy - y0);
    offY = Math.abs(cx - x0);
    width = y1 - y0;
    height = x1 - x0;
  } else {
    offX = Math.abs(cx - x0);
    offY = Math.abs(cy - y0);
    width = x1 - x0;
    height = y1 - y0;
  }
  const matrix: Matrix = [ra, rb, rc, rd, offX - ra * cx - rc * cy, offY - rb * cx - rd * cy];
  return { matrix, width, height };
}

/**
 * "Drawing frame" for new content placed by the user: origin at the
 * displayed page's bottom-left, y up, so text drawn in it appears upright
 * to the viewer regardless of /Rotate. Returns frame → user space.
 */
export function viewerFrameToUser(page: PDFPage): Matrix {
  const { matrix, height } = userToViewer(page);
  const flip: Matrix = [1, 0, 0, -1, 0, height];
  return multiply(flip, invert(matrix));
}
