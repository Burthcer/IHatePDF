/**
 * Compress in the desktop app's Rust engine (crates/ihp-core). Returns null (= use the TypeScript
 * worker) for anything the Rust engine can't fully handle: images it can't decode (JPEG 2000, CMYK,
 * Lab/Separation…), very large files, or any error. Never worse than the TypeScript result.
 */

import type { CompressPayload, ProcessedPdfResult } from '../../types/worker';
import { inputBytes, onNativeProgress, stageInput, type NativeHandler } from '../../services/nativeWorker';

/** Above this the TypeScript engine's lazy, streaming reader is the safer way to read the file. */
const MAX_NATIVE_BYTES = 1024 * 1024 * 1024;

const invoke = (cmd: string, args: unknown) => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__.core.invoke(cmd, args);

export const compressNative: NativeHandler = async (p: CompressPayload, ctx) => {
  if (inputBytes(p.fileBuffer) > MAX_NATIVE_BYTES) return null;
  const desktop = window.ihpDesktop!;
  const id = crypto.randomUUID();
  ctx.progress(2, 'Preparing...');
  const input = await stageInput(p.fileBuffer);
  const stop = await onNativeProgress(id, ctx.progress);
  let r: { path: string; size: number; pages: number; note: string; unchanged: boolean; skipped: number };
  try {
    r = await invoke('compress_pdf', { id, path: input, level: p.level, targetBytes: p.targetBytes ?? null });
  } finally {
    stop();
    void desktop.output.discard(input);
  }
  if (ctx.signal.aborted || r.skipped > 0) {
    void desktop.output.discard(r.path);
    return null;
  }
  ctx.progress(100, 'Done.');
  const base = p.fileName.replace(/\.[^/.]+$/, '');
  const out: ProcessedPdfResult = { fileName: `${base}_compressed.pdf`, output: { kind: 'file', path: r.path, size: r.size }, size: r.size, pageCount: r.pages, note: r.note || undefined };
  return out;
};
