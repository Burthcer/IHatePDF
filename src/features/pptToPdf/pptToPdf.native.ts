/**
 * PowerPoint to PDF in the desktop app: the Rust engine (crates/ihp-core/src/pptx.rs, same drawing rules as
 * pptToPdf.worker.ts, compared page by page in scripts/test-pptx-rust.ts). When Rust declines (a picture it can't embed exactly, an unreadable
 * package) the TypeScript worker runs.
 */
import type { OfficeConversionResult, PptToPdfPayload } from '../../types/worker';
import { fontAssets } from '../../services/fontAssets';
import { onNativeProgress, stageInput, type NativeHandler } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export const pptToPdfNative: NativeHandler = async (p: PptToPdfPayload, ctx) => {
  if (!p.fileBuffer?.byteLength || p.fileBuffer.byteLength > MAX_NATIVE_BYTES) return null;
  const desktop = window.ihpDesktop!;
  const id = crypto.randomUUID();
  ctx.progress(5, 'Preparing...');
  const stop = await onNativeProgress(id, ctx.progress);
  let r: { path: string; size: number; pages: number };
  try {
    const path = await stageInput(p.fileBuffer);
    r = await tauri().core.invoke('run_tool', { id, tool: 'pptx', inputs: [path], args: { fontAssets: fontAssets() } });
  } finally {
    stop();
  }
  const bytes = (await desktop.output.read(r.path)) as Uint8Array;
  void desktop.output.discard(r.path);
  if (ctx.signal.aborted) return null;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const out: OfficeConversionResult = { fileName: `${p.fileName.replace(/\.[^/.]+$/, '')}.pdf`, buffer, size: buffer.byteLength, mimeType: 'application/pdf', pageCount: r.pages };
  return out;
};
