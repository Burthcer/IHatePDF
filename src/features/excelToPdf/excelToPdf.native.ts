/**
 * Excel to PDF in the desktop app: the Rust engine (crates/ihp-core/src/xlsx.rs, same cell text and layout as
 * xlsxToPdf.worker.ts, compared in scripts/test-xlsx-rust.ts). When Rust declines (.xls/.ods/.csv, a number format or
 * value it can't reproduce exactly, a cell with a line break) the TypeScript worker runs.
 */
import type { OfficeConversionResult, XlsxToPdfPayload } from '../../types/worker';
import { fontAssets } from '../../services/fontAssets';
import { onNativeProgress, stageInput, type NativeHandler } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export const excelToPdfNative: NativeHandler = async (p: XlsxToPdfPayload, ctx) => {
  if (!p.fileBuffer?.byteLength || p.fileBuffer.byteLength > MAX_NATIVE_BYTES) return null;
  if (!/\.(xlsx|xlsm)$/i.test(p.fileName)) return null; // .xls, .ods and .csv are SheetJS's job
  const desktop = window.ihpDesktop!;
  const id = crypto.randomUUID();
  ctx.progress(5, 'Preparing...');
  const stop = await onNativeProgress(id, ctx.progress);
  let r: { path: string; size: number; pages: number };
  try {
    const path = await stageInput(p.fileBuffer);
    r = await tauri().core.invoke('run_tool', { id, tool: 'xlsx', inputs: [path], args: { fontAssets: fontAssets() } });
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
