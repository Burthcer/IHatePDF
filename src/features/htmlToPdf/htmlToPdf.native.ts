/**
 * HTML to PDF in the desktop app: the browser still lays the page out (captureLayout.ts); the Rust engine
 * (crates/ihp-core/src/html.rs) writes the PDF from the same display list. When Rust declines the
 * TypeScript worker runs. Job file: u32 LE JSON length, payload JSON (+ imageLens), then every PNG.
 */
import type { HtmlToPdfPayload, ProcessedPdfResult } from '../../types/worker';
import { fontAssets } from '../../services/fontAssets';
import { onNativeProgress, stageInput, type NativeHandler } from '../../services/nativeWorker';
import { MAX_NATIVE_BYTES } from '../../services/nativeTools';

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export const htmlToPdfNative: NativeHandler = async (p: HtmlToPdfPayload, ctx) => {
  const total = p.images.reduce((n, b) => n + b.byteLength, 0);
  if (total > MAX_NATIVE_BYTES) return null;
  const desktop = window.ihpDesktop!;
  const id = crypto.randomUUID();
  ctx.progress(5, 'Preparing...');
  const json = new TextEncoder().encode(JSON.stringify({ pages: p.pages, pageWidthPt: p.pageWidthPt, pageHeightPt: p.pageHeightPt, title: p.title, imageLens: p.images.map((b) => b.byteLength) }));
  const head = new Uint8Array(4);
  new DataView(head.buffer).setUint32(0, json.byteLength, true);
  const stop = await onNativeProgress(id, ctx.progress);
  let r: { path: string; size: number; pages: number };
  try {
    const path = await stageInput(new Blob([head, json, ...p.images]));
    r = await tauri().core.invoke('run_tool', { id, tool: 'html', inputs: [path], args: { fontAssets: fontAssets() } });
  } finally {
    stop();
  }
  const bytes = (await desktop.output.read(r.path)) as Uint8Array;
  void desktop.output.discard(r.path);
  if (ctx.signal.aborted) return null;
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const out: ProcessedPdfResult = { fileName: `${p.fileName.replace(/\.[^/.]+$/, '') || 'document'}.pdf`, buffer, size: buffer.byteLength, pageCount: r.pages };
  return out;
};
