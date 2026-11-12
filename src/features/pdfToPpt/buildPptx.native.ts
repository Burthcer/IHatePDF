/**
 * Desktop app: PDF to PowerPoint, rendering + writing in Rust (crates/ihp-core/src/pptx_out.rs: PDFium slide pictures
 * at 1600 px, OOXML package equal to the pptxgenjs one, compared in scripts/test-pdfppt-rust.ts). Returns null
 * whenever it can't (browser, huge file, any Rust error): the page then renders with pdf.js and builds with pptxgenjs.
 */
import { hasNative, inputBytes, onNativeProgress, stageInput } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';
import type { OfficeConversionResult, PdfInput, PptTextBox } from '../../types/worker';

export async function buildPptxNative(
  source: PdfInput,
  textBoxes: PptTextBox[][] | undefined,
  fileName: string,
  onProgress: (progress: number, stage: string) => void
): Promise<OfficeConversionResult | null> {
  if (!hasNative() || inputBytes(source) > MAX_NATIVE_BYTES) return null;
  const id = crypto.randomUUID();
  const stop = await onNativeProgress(id, onProgress);
  try {
    const path = await stageInput(source);
    const tauri = (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;
    const r: { path: string; size: number; pages: number } = await tauri.core.invoke('build_pptx', { id, path, boxes: textBoxes ?? null });
    const bytes = (await window.ihpDesktop!.output.read(r.path)) as Uint8Array;
    void window.ihpDesktop!.output.discard(r.path).catch(() => undefined);
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return {
      fileName: `${fileName.replace(/\.[^/.]+$/, '')}.pptx`,
      buffer,
      size: buffer.byteLength,
      mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      pageCount: r.pages,
    };
  } catch (err) {
    console.warn('Rust PowerPoint writer unavailable, using the TypeScript engine:', err);
    return null;
  } finally {
    stop();
  }
}
