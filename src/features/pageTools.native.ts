/** Rust versions of the page tools (crates/ihp-core/src/pages.rs). Same inputs and result names as the workers. */
import { nativeTool } from '../services/nativeTools';
import type { CropPayload, ImagesToPdfPayload, MergePayload, OrganizePayload, PageNumbersPayload, RotatePayload, SplitPayload, StampSignaturePayload, WatermarkPayload } from '../types/worker';

const base = (n: string) => n.replace(/\.[^/.]+$/, '');

export const mergeNative = nativeTool<MergePayload>({
  tool: 'merge',
  inputs: (p) => p.files.map((f) => f.buffer),
  name: (p) => {
    const n = p.outputName || 'merged.pdf';
    return { fileName: n.toLowerCase().endsWith('.pdf') ? n : `${n}.pdf` };
  },
});

export const rotateNative = nativeTool<RotatePayload>({
  tool: 'rotate',
  inputs: (p) => [p.fileBuffer],
  args: (p) => ({ rotations: p.rotations.map((r) => [r.pageIndex, r.degrees]), global: p.globalDegrees ?? 0 }),
  name: (p) => ({ fileName: `${base(p.fileName)}_rotated.pdf` }),
});

export const organizeNative = nativeTool<OrganizePayload>({
  tool: 'organize',
  inputs: (p) => [p.fileBuffer],
  args: (p) => {
    const deleted = new Set(p.deletedPages ?? []);
    // Same rule as organize.worker.ts: -1 is a blank page; deleted pages drop out; rotations follow the order.
    const specs = p.pageOrder.map((idx, i) => [idx, p.rotations?.[i] ?? 0]).filter(([idx]) => idx === -1 || (idx >= 0 && !deleted.has(idx)));
    return { specs };
  },
  name: (p) => ({ fileName: `${base(p.fileName)}_organized.pdf` }),
});

export const cropNative = nativeTool<CropPayload>({
  tool: 'crop',
  inputs: (p) => [p.fileBuffer],
  args: (p) => ({ margins: p.margins, pageIndices: p.pageIndices }),
  name: (p) => ({ fileName: `${base(p.fileName)}_cropped.pdf` }),
});

export const splitNative = nativeTool<SplitPayload>({
  tool: 'split',
  inputs: (p) => [p.fileBuffer],
  args: (p) => ({
    base: base(p.fileName),
    groups: p.groups,
    all: !p.groups && p.ranges === 'all',
    ranges: Array.isArray(p.ranges) ? p.ranges : undefined,
  }),
  name: (p, rust) => ({ fileName: rust ?? `${base(p.fileName)}_split.pdf`, mimeType: rust?.endsWith('.zip') ? 'application/zip' : undefined }),
});

const MARGINS = { none: 0, small: 18, big: 54 } as const;

/** Images to PDF (also used by Scan to PDF). */
export const imagesNative = nativeTool<ImagesToPdfPayload>({
  tool: 'images',
  inputs: (p) => p.images.map((i) => i.bytes),
  args: (p) => ({ png: p.images.map((i) => i.type === 'png'), pageSize: p.pageSize, orientation: p.orientation, marginPt: MARGINS[p.margin] }),
  name: (p) => ({ fileName: `${base(p.fileName) || 'images'}.pdf` }),
});

/** Stamp tools in Rust: standard-font text only (Unicode scripts fall back to the TypeScript engine). */
export const pageNumbersNative = nativeTool<PageNumbersPayload>({
  tool: 'pagenumbers',
  inputs: (p) => [p.fileBuffer],
  args: (p) => ({ ...p, fileBuffer: undefined }),
  name: (p) => ({ fileName: `${base(p.fileName)}_numbered.pdf` }),
});

export const watermarkNative = nativeTool<WatermarkPayload>({
  tool: 'watermark',
  inputs: (p) => (p.mode === 'image' && p.imageBytes ? [p.fileBuffer, p.imageBytes] : [p.fileBuffer]),
  args: (p) => ({ ...p, fileBuffer: undefined, imageBytes: undefined }),
  name: (p) => ({ fileName: `${base(p.fileName)}_watermarked.pdf` }),
});

export const signNative = nativeTool<StampSignaturePayload>({
  tool: 'sign',
  inputs: (p) => [p.fileBuffer, p.signatureImageBytes],
  args: (p) => ({ placements: p.placements }),
  name: (p) => ({ fileName: `${base(p.fileName)}_signed.pdf` }),
});
