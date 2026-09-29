/**
 * The request/progress/response loop every tool worker shares. `run` gets a
 * progress callback, an output sink that streams its file to the page (see
 * workerOutput.ts), and `ask`, for things only the page can do (render a
 * page with pdf.js and a canvas) — one at a time, when the worker needs them.
 */

import { openOutput, type OutputSink } from './workerOutput';
import { friendlyError } from './friendlyErrors';
import type { WorkerRequest } from '../types/worker';

export interface TaskContext {
  id: string;
  progress: (progress: number, stage: string) => void;
  /** The output channel for this request (opened on first use). */
  sink: () => OutputSink;
  /** Asks the page for something (see useWorkerBridge's onAsk) and waits for the answer. */
  ask: <T>(what: string, data: unknown) => Promise<T>;
}

const answers = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
if (typeof self !== 'undefined' && typeof (self as { addEventListener?: unknown }).addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent) => {
    const m = event.data;
    if (m?.type !== 'ANSWER') return;
    const waiting = answers.get(m.askId);
    if (!waiting) return;
    answers.delete(m.askId);
    if (m.error) waiting.reject(new Error(m.error));
    else waiting.resolve(m.result);
  });
}

export function serveTask<P, R>(action: string, run: (payload: P, ctx: TaskContext) => Promise<R>, fallbackError: string) {
  if (typeof self === 'undefined' || typeof (self as { addEventListener?: unknown }).addEventListener !== 'function') return;
  self.addEventListener('message', async (event: MessageEvent<WorkerRequest<P>>) => {
    const { id, action: a, payload } = event.data ?? ({} as WorkerRequest<P>);
    if (a !== action) return;
    let sink: OutputSink | null = null;
    const ctx: TaskContext = {
      id,
      progress: (progress, stage) => self.postMessage({ type: 'PROGRESS', payload: { id, progress, stage } }),
      sink: () => (sink ??= openOutput(id)),
      ask: <T,>(what: string, data: unknown) =>
        new Promise<T>((resolve, reject) => {
          const askId = `${id}:${Math.random().toString(36).slice(2)}`;
          answers.set(askId, { resolve: resolve as (v: unknown) => void, reject });
          self.postMessage({ type: 'ASK', payload: { id, askId, what, data } });
        }),
    };
    try {
      const data = await run(payload, ctx);
      const buffer = (data as { buffer?: unknown } | null)?.buffer;
      (self as unknown as Worker).postMessage({ type: 'RESPONSE', payload: { id, success: true, data } }, buffer instanceof ArrayBuffer ? [buffer] : []);
    } catch (err) {
      (sink as OutputSink | null)?.abort();
      const e = err as { message?: string; code?: string };
      const fileName = (payload as { fileName?: string } | undefined)?.fileName;
      // Coded errors (wrong password…) are already meant for people.
      const message = e?.code ? e.message || fallbackError : friendlyError(e?.message || fallbackError, { fileName, tool: action === 'REPAIR_PDF' ? 'repair' : undefined });
      self.postMessage({ type: 'RESPONSE', payload: { id, success: false, error: message, code: e?.code } });
    }
  });
}
