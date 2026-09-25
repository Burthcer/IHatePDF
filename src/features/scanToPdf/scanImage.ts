/**
 * Image processing for scanned pages: perspective correction from four
 * corners (homography + bilinear sampling) and document-style clean-up
 * filters. Pure canvas/ImageData code, no dependencies.
 */

export type Point = { x: number; y: number };
export type ScanFilter = 'original' | 'gray' | 'document';

/** Solves the 3×3 homography mapping unit-square corners to `quad` (tl, tr, br, bl). */
function squareToQuad(q: Point[]): number[] {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  let a13 = 0, a23 = 0;
  const det = dx1 * dy2 - dx2 * dy1;
  if (Math.abs(det) > 1e-9) {
    a13 = (dx3 * dy2 - dx2 * dy3) / det;
    a23 = (dx1 * dy3 - dx3 * dy1) / det;
  }
  return [
    p1.x - p0.x + a13 * p1.x, p3.x - p0.x + a23 * p3.x, p0.x,
    p1.y - p0.y + a13 * p1.y, p3.y - p0.y + a23 * p3.y, p0.y,
    a13, a23, 1,
  ];
}

/** Warps the quad in `src` to an upright rectangle. */
export function warpQuad(src: HTMLCanvasElement | ImageBitmap, quad: Point[]): HTMLCanvasElement {
  const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
  const outW = Math.round(Math.max(dist(quad[0], quad[1]), dist(quad[3], quad[2])));
  const outH = Math.round(Math.max(dist(quad[0], quad[3]), dist(quad[1], quad[2])));
  const sw = src.width;
  const sh = src.height;
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = sw;
  srcCanvas.height = sh;
  const sctx = srcCanvas.getContext('2d', { willReadFrequently: true })!;
  sctx.drawImage(src, 0, 0);
  const sdata = sctx.getImageData(0, 0, sw, sh).data;
  const out = document.createElement('canvas');
  out.width = Math.max(1, outW);
  out.height = Math.max(1, outH);
  const octx = out.getContext('2d')!;
  const img = octx.createImageData(out.width, out.height);
  const d = img.data;
  const H = squareToQuad(quad);
  for (let y = 0; y < out.height; y++) {
    const v = (y + 0.5) / out.height;
    for (let x = 0; x < out.width; x++) {
      const u = (x + 0.5) / out.width;
      const w = H[6] * u + H[7] * v + H[8];
      const sx = (H[0] * u + H[1] * v + H[2]) / w - 0.5;
      const sy = (H[3] * u + H[4] * v + H[5]) / w - 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(sx)));
      const y0 = Math.max(0, Math.min(sh - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0));
      const fy = Math.min(1, Math.max(0, sy - y0));
      const i00 = (y0 * sw + x0) * 4, i10 = i00 + 4, i01 = i00 + sw * 4, i11 = i01 + 4;
      const o = (y * out.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        d[o + c] = (sdata[i00 + c] * (1 - fx) + sdata[i10 + c] * fx) * (1 - fy) + (sdata[i01 + c] * (1 - fx) + sdata[i11 + c] * fx) * fy;
      }
      d[o + 3] = 255;
    }
  }
  octx.putImageData(img, 0, 0);
  return out;
}

/** In-place filter. "document" evens out lighting and pushes paper to white. */
export function applyFilter(canvas: HTMLCanvasElement, filter: ScanFilter): void {
  if (filter === 'original') return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  const w = canvas.width;
  const h = canvas.height;
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) gray[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

  if (filter === 'gray') {
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) d[p] = d[p + 1] = d[p + 2] = gray[i];
    ctx.putImageData(img, 0, 0);
    return;
  }

  // Background estimate: heavily downsampled max filter, blurred back up —
  // i.e. "what the paper looks like here" — then divide it out.
  const cell = Math.max(8, Math.round(Math.min(w, h) / 40));
  const gw = Math.ceil(w / cell);
  const gh = Math.ceil(h / cell);
  const grid = new Float32Array(gw * gh);
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let m = 0;
      for (let y = gy * cell; y < Math.min(h, (gy + 1) * cell); y += 2) {
        for (let x = gx * cell; x < Math.min(w, (gx + 1) * cell); x += 2) m = Math.max(m, gray[y * w + x]);
      }
      grid[gy * gw + gx] = m;
    }
  }
  const bg = (x: number, y: number) => {
    const fx = Math.min(gw - 1, Math.max(0, x / cell - 0.5));
    const fy = Math.min(gh - 1, Math.max(0, y / cell - 0.5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy);
    const x1 = Math.min(gw - 1, x0 + 1), y1 = Math.min(gh - 1, y0 + 1);
    const tx = fx - x0, ty = fy - y0;
    return (grid[y0 * gw + x0] * (1 - tx) + grid[y0 * gw + x1] * tx) * (1 - ty) + (grid[y1 * gw + x0] * (1 - tx) + grid[y1 * gw + x1] * tx) * ty;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const b = Math.max(40, bg(x, y));
      let v = (gray[i] / b) * 255;
      v = v > 215 ? 255 : Math.max(0, (v - 40) * (255 / 175)); // whiten paper, deepen ink
      const p = i * 4;
      d[p] = d[p + 1] = d[p + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}
