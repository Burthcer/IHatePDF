/**
 * The request/progress/response loop every tool worker shares. `run` gets a
 * progress callback and, if the tool writes a file, an output sink that
 * streams it to the page (see workerOutput.ts).
 */

import { openOutput, type OutputSink } from './workerOutput';
import { friendlyError } from './friendlyErrors';
import type { WorkerRequest } from '../types/worker';

export interface TaskContext {
  id: string;
  progress: (progress: number, stage: string) => void;
  /** The output channel for this request (opened on first use). */
  sink: () => OutputSink;
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
