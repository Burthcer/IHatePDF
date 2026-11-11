/** Redaction in the desktop app: PDFium renders each flagged page with the boxes burned in (Rust). Null = not available. */
import type { PdfInput, ProcessedPdfResult, RedactPdfPayload, RedactionBox } from '../../types/worker';
import { hasNative, inputBytes, onNativeProgress, stageInput } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export async function redactNative(
  input: PdfInput,
  fileName: string,
  pages: RedactPdfPayload['pages'],
  boxes: RedactionBox[],
  stripMetadata: boolean,
  progress: (p: number, stage: string) => void
): Promise<ProcessedPdfResult | null> {
  if (!hasNative() || inputBytes(input) > MAX_NATIVE_BYTES) return null;
  const desktop = window.ihpDesktop!;
  const id = crypto.randomUUID();
  const path = await stageInput(input);
  const stop = await onNativeProgress(id, progress);
  try {
    const r: { path: string; size: number; pages: number; redacted: number } = await tauri().core.invoke('redact_pdf', {
      id,
      path,
      pages: pages.map((p) => ({ pageIndex: p.pageIndex, widthPt: p.widthPt, heightPt: p.heightPt })),
      boxes,
      stripMetadata,
    });
    return {
      fileName: `${fileName.replace(/\.[^/.]+$/, '')}_redacted.pdf`,
      output: { kind: 'file', path: r.path, size: r.size },
      size: r.size,
      pageCount: r.pages,
      note: `${r.redacted} page${r.redacted === 1 ? '' : 's'} flattened; ${r.pages - r.redacted} left untouched.`,
    };
  } finally {
    stop();
    void desktop.output.discard(path);
  }
}
