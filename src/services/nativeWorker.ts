/**
 * Runs a tool in the desktop app's Rust engine when it can, and in the original TypeScript
 * worker when it can't (a browser, a file the Rust engine declines, or any Rust error), so a tool
 * never does worse than before. `nativeFirst` returns a Worker-shaped object that the existing
 * `useToolRunner` / `useWorkerBridge` use unchanged: same messages (PROGRESS, RESPONSE), same results.
 */

import type { ProcessedPdfResult, PdfInput, ToolOutput, WorkerRequest } from '../types/worker';

export interface NativeContext {
  progress(progress: number, stage: string): void;
  signal: AbortSignal;
}
/** Resolves a result, or `null` to hand the job to the TypeScript worker. */
export type NativeHandler = (payload: any, ctx: NativeContext) => Promise<unknown | null>;

interface TauriGlobal {
  core: { invoke: (cmd: string, args?: unknown) => Promise<any> };
  event: { listen: (name: string, cb: (e: { payload: any }) => void) => Promise<() => void> };
}
const tauri = () => (globalThis as unknown as { __TAURI__?: TauriGlobal }).__TAURI__;
export const hasNative = () => !!tauri() && !!window.ihpDesktop;

const STEP = 8 * 1024 * 1024;

const staged = new Map<PdfInput, Promise<string>>();
const KEEP_STAGED = 4;

/**
 * A PDF (bytes or a disk-backed Blob) in the app's work folder, copied once and then reused by
 * whatever needs it (page count, previews, the tool). The newest few stay; older ones are deleted.
 */
export function stageInput(input: PdfInput): Promise<string> {
  let p = staged.get(input);
  if (!p) {
    p = copyToWorkFolder(input);
    p.catch(() => staged.delete(input));
    staged.set(input, p);
    while (staged.size > KEEP_STAGED) {
      const [oldKey, old] = staged.entries().next().value as [PdfInput, Promise<string>];
      staged.delete(oldKey);
      void old.then((path) => window.ihpDesktop?.output.discard(path)).catch(() => undefined);
    }
  }
  return p;
}

async function copyToWorkFolder(input: PdfInput): Promise<string> {
  const out = window.ihpDesktop!.output;
  const handle = await out.create();
  try {
    if (input instanceof Blob) {
      const reader = input.stream().getReader();
      let carry: Uint8Array[] = [];
      let carried = 0;
      const flush = async () => {
        if (!carried) return;
        const chunk = new Uint8Array(carried);
        let at = 0;
        for (const c of carry) {
          chunk.set(c, at);
          at += c.length;
        }
        carry = [];
        carried = 0;
        await out.write(handle, chunk);
      };
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          carry.push(value);
          carried += value.length;
          if (carried >= STEP) await flush();
        }
        if (done) break;
      }
      await flush();
    } else {
      for (let at = 0; at < input.byteLength; at += STEP) await out.write(handle, new Uint8Array(input, at, Math.min(STEP, input.byteLength - at)));
    }
  } catch (e) {
    await out.close(handle, true).catch(() => undefined);
    throw e;
  }
  return (await out.close(handle)).path;
}

export const inputBytes = (input: PdfInput) => (input instanceof Blob ? input.size : input.byteLength);

/** Subscribes to the Rust engine's progress events for one job. */
export async function onNativeProgress(id: string, cb: (progress: number, stage: string) => void): Promise<() => void> {
  const un = await tauri()!.event.listen('ihp:progress', (e) => {
    if (e.payload?.id === id) cb(e.payload.progress, e.payload.stage);
  });
  return un;
}

export function nativeFirst(factory: () => Worker, handlers: Record<string, NativeHandler>): () => Worker {
  return () => {
    const target = new EventTarget();
    let real: Worker | null = null;
    let abort = new AbortController();
    const post = (data: unknown) => target.dispatchEvent(new MessageEvent('message', { data }));
    const realWorker = () => {
      if (!real) {
        real = factory();
        real.addEventListener('message', (e) => post((e as MessageEvent).data));
        real.addEventListener('error', (e) => target.dispatchEvent(new ErrorEvent('error', { message: (e as ErrorEvent).message })));
      }
      return real;
    };
    const fake = {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
      terminate() {
        abort.abort();
        real?.terminate();
        real = null;
      },
      postMessage(msg: WorkerRequest<unknown> & { type?: string }, transfer?: Transferable[]) {
        const handler = hasNative() && msg && typeof msg === 'object' && 'action' in msg ? handlers[msg.action as string] : undefined;
        if (!handler) {
          // Not a native job (or a protocol message such as OUTPUT_ACK): the TypeScript worker's business.
          if (real || (msg && 'action' in msg)) realWorker().postMessage(msg, transfer ?? []);
          return;
        }
        abort = new AbortController();
        const ctx: NativeContext = { signal: abort.signal, progress: (progress, stage) => post({ type: 'PROGRESS', payload: { id: msg.id, progress, stage } }) };
        handler(msg.payload, ctx).then(
          (data) => {
            if (abort.signal.aborted) return;
            if (data === null) realWorker().postMessage(msg, transfer ?? []);
            else post({ type: 'RESPONSE', payload: { id: msg.id, success: true, data } });
          },
          (err) => {
            if (abort.signal.aborted) return;
            console.warn('Rust engine declined, using the TypeScript one:', err);
            realWorker().postMessage(msg, transfer ?? []);
          }
        );
      },
    };
    return fake as unknown as Worker;
  };
}

export type { ProcessedPdfResult, ToolOutput };
