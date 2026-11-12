/**
 * Desktop app: PDF to PowerPoint backgrounds (the pages with all text removed) from PDFium. Returns null
 * whenever PDFium can't do it (browser, huge file, text inside a form XObject): the TypeScript worker
 * then produces the backgrounds.
 */
import { hasNative, inputBytes, stageInput } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';
import type { PdfInput } from '../../types/worker';

export async function stripTextNative(data: PdfInput): Promise<ArrayBuffer | null> {
  if (!hasNative() || inputBytes(data) > MAX_NATIVE_BYTES) return null;
  try {
    const path = await stageInput(data);
    const tauri = (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;
    const r: { path: string } = await tauri.core.invoke('strip_pdf_text', { path });
    const bytes = (await window.ihpDesktop!.output.read(r.path)) as Uint8Array;
    void window.ihpDesktop!.output.discard(r.path).catch(() => undefined);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } catch (err) {
    console.warn('PDFium text removal unavailable, using the TypeScript engine:', err);
    return null;
  }
}
