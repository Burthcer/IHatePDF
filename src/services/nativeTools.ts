/**
 * Generic bridge from a worker payload to the Rust `run_tool` command (see src-tauri/src/native.rs):
 * stages the input PDFs in the app's work folder, runs the tool, and returns the result as a
 * work-folder file. Anything that goes wrong (or a file over the size cap) returns null /
 * throws, and `nativeFirst` then runs the original TypeScript worker instead.
 */

import type { PdfInput, ProcessedPdfResult } from '../types/worker';
import { inputBytes, onNativeProgress, stageInput, type NativeHandler } from './nativeWorker';

/** Bigger inputs stay with the TypeScript engine's lazy, streaming reader. */
export const MAX_NATIVE_BYTES = 1024 * 1024 * 1024;

const tauri = () => (globalThis as unknown as { __TAURI__: { core: { invoke: (c: string, a: unknown) => Promise<any> } } }).__TAURI__;

export interface NativeToolSpec<P> {
  tool: string;
  inputs(p: P): PdfInput[];
  args?(p: P): unknown;
  /** Result name (and optionally MIME type) when Rust doesn't name it itself. */
  name(p: P, rustName: string | null): { fileName: string; mimeType?: string };
}

export function nativeTool<P>(spec: NativeToolSpec<P>): NativeHandler {
  return async (p: P, ctx) => {
    const inputs = spec.inputs(p);
    if (inputs.reduce((n, i) => n + inputBytes(i), 0) > MAX_NATIVE_BYTES) return null;
    const desktop = window.ihpDesktop!;
    const id = crypto.randomUUID();
    ctx.progress(2, 'Preparing...');
    const staged: string[] = [];
    let r: { path: string; size: number; pages: number; fileName: string | null };
    const stop = await onNativeProgress(id, ctx.progress);
    try {
      for (const i of inputs) staged.push(await stageInput(i));
      r = await tauri().core.invoke('run_tool', { id, tool: spec.tool, inputs: staged, args: spec.args?.(p) ?? {} });
    } finally {
      stop();
      staged.forEach((s) => void desktop.output.discard(s));
    }
    if (ctx.signal.aborted) {
      void desktop.output.discard(r.path);
      return null;
    }
    ctx.progress(100, 'Done.');
    const { fileName, mimeType } = spec.name(p, r.fileName);
    const out: ProcessedPdfResult = { fileName, output: { kind: 'file', path: r.path, size: r.size }, size: r.size, pageCount: r.pages };
    return mimeType ? { ...out, mimeType } : out;
  };
}
