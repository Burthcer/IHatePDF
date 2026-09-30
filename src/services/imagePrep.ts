/**
 * Normalizes user images for embedding in PDFs: pdf-lib only takes PNG and
 * baseline JPEG, and ignores EXIF orientation (so phone photos come out
 * sideways). Everything else — WebP, GIF, BMP, AVIF, rotated JPEGs,
 * CMYK/progressive JPEGs the browser can read — is redrawn through a canvas.
 */

import { memoryManager } from './memoryManager';
import { MemoryLimitError, memoryState } from './memoryGuard';

export interface PreparedImage {
  /** The picked file itself when usable as is (read from disk only when the PDF is written). */
  data: Blob;
  type: 'png' | 'jpg';
  url: string;
  /** Pixel size, when the file's header says (PNG, JPEG). */
  width?: number;
  height?: number;
}

/** Width and height from a PNG or JPEG header, without decoding the image. */
export function imageSize(buf: ArrayBuffer): { width: number; height: number } | null {
  const v = new DataView(buf);
  if (v.byteLength >= 24 && v.getUint32(0) === 0x89504e47 && v.getUint32(12) === 0x49484452) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return null;
  let off = 2;
  while (off + 9 < v.byteLength) {
    const marker = v.getUint16(off);
    if ((marker & 0xff00) !== 0xff00) return null;
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), carry the frame size.
    if (marker >= 0xffc0 && marker <= 0xffcf && marker !== 0xffc4 && marker !== 0xffc8 && marker !== 0xffcc) {
      return { width: v.getUint16(off + 7), height: v.getUint16(off + 5) };
    }
    off += 2 + v.getUint16(off + 2);
  }
  return null;
}

/** Above this many pixels an image isn't decoded just to check it can be read. */
const CHECK_DECODE_PIXELS = 40_000_000;

/**
 * Memory fail-safe for an image that has to be decoded whole (one piece that
 * can't be split): refuses it up front, with the usual message, when decoding
 * it (`copies` × 4 bytes a pixel) would need more than the budget.
 */
export function assertDecodable(size: { width: number; height: number } | null, copies: number): void {
  if (!size) return;
  // Against the PC's budget: an image this PC could decode is never refused just because Windows is busy right now.
  const state = memoryState();
  if (size.width * size.height * 4 * copies > state.budgetMB * 1024 * 1024) throw new MemoryLimitError({ ...state, reason: 'too-big' });
}

/** EXIF lives in the first 64 KB of a JPEG. */
const HEAD_BYTES = 256 * 1024;

/** EXIF orientation (1-8) of a JPEG, or 1. */
export function jpegOrientation(buf: ArrayBuffer): number {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xffd8) return 1;
  let off = 2;
  while (off + 4 < v.byteLength) {
    const marker = v.getUint16(off);
    const len = v.getUint16(off + 2);
    if (marker === 0xffe1 && v.getUint32(off + 4) === 0x45786966) {
      const tiff = off + 10;
      const little = v.getUint16(tiff) === 0x4949;
      const ifd = tiff + v.getUint32(tiff + 4, little);
      const count = v.getUint16(ifd, little);
      for (let i = 0; i < count; i++) {
        const entry = ifd + 2 + i * 12;
        if (entry + 10 > v.byteLength) break;
        if (v.getUint16(entry, little) === 0x0112) return v.getUint16(entry + 8, little) || 1;
      }
      return 1;
    }
    if ((marker & 0xff00) !== 0xff00 || marker === 0xffda) break;
    off += 2 + len;
  }
  return 1;
}

function isBaselineOrProgressiveJpeg(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(buf.byteLength, 4));
  return b[0] === 0xff && b[1] === 0xd8;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const head = await file.slice(0, HEAD_BYTES).arrayBuffer();
  const size = imageSize(head);

  const isJpeg = file.type === 'image/jpeg' || (file.type === '' && isBaselineOrProgressiveJpeg(head));
  const isPng = file.type === 'image/png';
  if ((isJpeg && jpegOrientation(head) === 1) || isPng) {
    // Must still be a readable image (a huge one is taken on its header's word).
    if (!size || size.width * size.height <= CHECK_DECODE_PIXELS) (await createImageBitmap(file)).close();
    const url = memoryManager.registerUrl(URL.createObjectURL(file));
    return { data: file, type: isPng ? 'png' : 'jpg', url, ...size };
  }

  // Redrawn through a canvas: the decoded image and the canvas, whole.
  assertDecodable(size, 2);
  const url = memoryManager.registerUrl(URL.createObjectURL(file));

  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  // Photos stay JPEG; anything that might have transparency becomes PNG.
  const asJpeg = isJpeg;
  const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, asJpeg ? 'image/jpeg' : 'image/png', 0.92));
  canvas.width = 0;
  if (!blob) throw new Error(`Couldn't read ${file.name}.`);
  return { data: blob, type: asJpeg ? 'jpg' : 'png', url, width, height };
}
