/** PDF to JPG/PNG with PDFium in the desktop app. Returns null when it can't (the pdf.js path then runs). */
import type { PdfInput, ProcessedPdfResult } from '../../types/worker';
import { hasNative, inputBytes, onNativeProgress, stageInput } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export async function renderNative(
  input: PdfInput,
  fileName: string,
  pages: number[],
  opts: { dpi: number; png: boolean; quality: number },
  progress: (p: number, stage: string) => void
): Promise<(ProcessedPdfResult & { mimeType?: string }) | null> {
  if (!hasNative() || inputBytes(input) > MAX_NATIVE_BYTES) return null;
  const id = crypto.randomUUID();
  progress(1, 'Preparing...');
  const path = await stageInput(input);
  const stop = await onNativeProgress(id, progress);
  try {
    const base = fileName.replace(/\.[^/.]+$/, '');
    const r: { path: string; size: number; pages: number; fileName: string } = await tauri().core.invoke('render_pdf', { id, path, pages, dpi: opts.dpi, png: opts.png, quality: opts.quality, base });
    return { fileName: r.fileName, output: { kind: 'file', path: r.path, size: r.size }, size: r.size, pageCount: r.pages, mimeType: r.fileName.endsWith('.zip') ? 'application/zip' : opts.png ? 'image/png' : 'image/jpeg' };
  } finally {
    stop();
  }
}
