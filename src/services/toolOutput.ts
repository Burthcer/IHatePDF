/**
 * Page side of streamed tool output (see workerOutput.ts): chunks from a
 * worker are appended to a temp file through the desktop app, or collected
 * into a Blob in a browser, and acknowledged so the worker can send more.
 * Also the one place results are saved, sized and discarded.
 */

import type { ToolOutput } from '../types/worker';

interface OutputMessage {
  id: string;
  op: 'open' | 'chunk' | 'close' | 'abort';
  chunk?: Uint8Array;
}

type Collected = { kind: 'file'; handle: string } | { kind: 'blob'; blob: Blob; parts: Uint8Array[]; partBytes: number };

const COMPACT_BYTES = 32 * 1024 * 1024;

/** Receives streamed outputs from one worker. */
export class OutputCollector {
  private readonly open = new Map<string, Promise<Collected>>();
  private readonly done = new Map<string, Promise<ToolOutput | null>>();
  private readonly queue = new Map<string, Promise<unknown>>();

  /** `blobs`: always collect into Blobs (outputs the app itself keeps using, e.g. decrypted inputs). */
  constructor(
    private readonly worker: Worker,
    private readonly blobs = false
  ) {}

  /** Returns true if `message` was an output message. */
  handle(message: { type?: string; payload?: OutputMessage }): boolean {
    if (message?.type !== 'OUTPUT' || !message.payload) return false;
    const m = message.payload;
    // Keep each output's operations in order; the worker waits for acks.
    const prev = this.queue.get(m.id) ?? Promise.resolve();
    const next = prev.then(() => this.apply(m)).catch((err) => {
      console.error('Output write failed', err);
      this.done.set(m.id, Promise.reject(err instanceof Error ? err : new Error(String(err))));
    });
    this.queue.set(m.id, next);
    return true;
  }

  private async apply(m: OutputMessage) {
    if (m.op === 'open') {
      const desktop = this.blobs ? undefined : window.ihpDesktop?.output;
      this.open.set(m.id, Promise.resolve(desktop ? { kind: 'file', handle: await desktop.create() } : { kind: 'blob', blob: new Blob([]), parts: [], partBytes: 0 }));
      return;
    }
    const target = await this.open.get(m.id);
    if (!target) return;
    if (m.op === 'chunk' && m.chunk) {
      if (target.kind === 'file') await window.ihpDesktop!.output.write(target.handle, m.chunk);
      else {
        target.parts.push(m.chunk);
        target.partBytes += m.chunk.byteLength;
        if (target.partBytes >= COMPACT_BYTES) {
          // Hand the bytes to the browser's blob storage and drop our copy.
          target.blob = new Blob([target.blob, ...(target.parts as BlobPart[])]);
          target.parts = [];
          target.partBytes = 0;
        }
      }
      this.worker.postMessage({ type: 'OUTPUT_ACK', id: m.id });
      return;
    }
    if (m.op === 'close') {
      this.open.delete(m.id);
      if (target.kind === 'file') {
        const r = await window.ihpDesktop!.output.close(target.handle);
        this.done.set(m.id, Promise.resolve({ kind: 'file', path: r.path, size: r.size }));
      } else {
        const blob = new Blob([target.blob, ...(target.parts as BlobPart[])], { type: 'application/pdf' });
        this.done.set(m.id, Promise.resolve({ kind: 'blob', blob, size: blob.size }));
      }
      return;
    }
    if (m.op === 'abort') {
      this.open.delete(m.id);
      if (target.kind === 'file') await window.ihpDesktop!.output.close(target.handle, true);
      this.done.set(m.id, Promise.resolve(null));
    }
  }

  /** The worker is gone (cancelled or crashed): discard anything half-written. */
  dispose() {
    for (const [id, target] of this.open) {
      void target.then((t) => (t.kind === 'file' ? window.ihpDesktop?.output.close(t.handle, true) : undefined)).catch(() => undefined);
      this.open.delete(id);
    }
    this.done.clear();
    this.queue.clear();
  }

  /** Replaces a streamed output handle in a worker result with the stored file/blob. */
  async resolve<T>(data: T): Promise<T> {
    const out = (data as { output?: ToolOutput } | undefined)?.output;
    if (!out || out.kind !== 'stream') return data;
    await this.queue.get(out.id);
    const stored = await this.done.get(out.id);
    this.done.delete(out.id);
    this.queue.delete(out.id);
    if (!stored) throw new Error('The output file was not stored.');
    return { ...(data as object), output: stored } as T;
  }
}

// ------------------------------------------------------------------ results

export type ResultData = ArrayBuffer | ToolOutput;

export function resultSize(data: ResultData): number {
  return data instanceof ArrayBuffer ? data.byteLength : data.size;
}

/** Saves a result under `fileName` (desktop: copied from the temp file; browser: downloaded). */
export async function saveResult(data: ResultData, fileName: string, mimeType = 'application/pdf'): Promise<void> {
  if (!(data instanceof ArrayBuffer) && data.kind === 'file') {
    await window.ihpDesktop!.output.save(data.path, fileName);
    return;
  }
  // (Wrapping a Blob only references its data.)
  const blob = data instanceof ArrayBuffer ? new Blob([data], { type: mimeType }) : data.kind === 'blob' ? new Blob([data.blob], { type: mimeType }) : null;
  if (!blob) throw new Error('This result is not ready yet.');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Frees a result's storage (temp file) once it's no longer shown. */
export function discardResult(data: ResultData | null | undefined) {
  if (data && !(data instanceof ArrayBuffer) && data.kind === 'file') void window.ihpDesktop?.output.discard(data.path);
}

/** Reads a result back into memory (small results only: previews). */
export async function readResult(data: ResultData): Promise<Blob> {
  if (data instanceof ArrayBuffer) return new Blob([data]);
  if (data.kind === 'blob') return data.blob;
  if (data.kind === 'file') return new Blob([(await window.ihpDesktop!.output.read(data.path)) as BlobPart]);
  throw new Error('This result is not ready yet.');
}
