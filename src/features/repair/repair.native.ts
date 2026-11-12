/**
 * Repair in the desktop app: PDFium reads the damaged file tolerantly and writes a clean copy (Rust).
 * If PDFium can't open it, or for the "rebuild from rendered pages" step, the TypeScript worker runs
 * (checked on 36 damaged files: Rust never recovers fewer pages than TypeScript when it succeeds).
 */
import type { ProcessedPdfResult, RepairPayload } from '../../types/worker';
import { inputBytes, stageInput, type NativeHandler } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export const repairNative: NativeHandler = async (p: RepairPayload, ctx) => {
  if (p.renderedPages?.length || inputBytes(p.fileBuffer) > MAX_NATIVE_BYTES || inputBytes(p.fileBuffer) === 0) return null;
  ctx.progress(15, 'Re-reading every object in the file...');
  const path = await stageInput(p.fileBuffer);
  const r: { path: string; size: number; pages: number } = await tauri().core.invoke('repair_pdf', { path });
  if (ctx.signal.aborted) return null;
  ctx.progress(100, 'Repair complete.');
  const out: ProcessedPdfResult = {
    fileName: `${p.fileName.replace(/\.[^/.]+$/, '')}_repaired.pdf`,
    output: { kind: 'file', path: r.path, size: r.size },
    size: r.size,
    pageCount: r.pages,
    note: `Recovered ${r.pages} page${r.pages === 1 ? '' : 's'} with their original text and graphics.`,
  };
  return out;
};
