/**
 * Promise-based client for a long-lived worker that can have several
 * requests in flight (unlike useWorkerBridge, which runs one task at a time
 * and restarts the worker to cancel). Used by stateful workers such as the
 * editor's session worker.
 */

import { OutputCollector } from './toolOutput';
import { attachWorker, registerJob } from './memoryGuard';

export class WorkerCallError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = 'WorkerCallError';
    this.code = code;
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  onProgress?: (progress: number, stage: string) => void;
};

export class WorkerClient {
  private worker: Worker | null = null;
  private pending = new Map<string, Pending>();
  private outputs: OutputCollector | null = null;
  private detachMemory: (() => void) | null = null;
  private endJob: (() => void) | null = null;

  /** `blobOutputs`: streamed outputs become Blobs even in the desktop app (see OutputCollector). */
  constructor(
    private readonly factory: () => Worker,
    private readonly blobOutputs = false
  ) {
    this.start();
  }

  private start(): Worker {
    const worker = this.factory();
    const outputs = new OutputCollector(worker, this.blobOutputs);
    this.worker = worker;
    this.outputs = outputs;
    this.detachMemory = attachWorker(worker);
    worker.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.payload) return;
      if (outputs.handle(msg)) return;
      const entry = this.pending.get(msg.payload.id);
      if (!entry) return;
      if (msg.type === 'PROGRESS') {
        entry.onProgress?.(msg.payload.progress, msg.payload.stage);
      } else if (msg.type === 'RESPONSE') {
        this.pending.delete(msg.payload.id);
        this.jobDone();
        if (msg.payload.success) outputs.resolve(msg.payload.data).then(entry.resolve, entry.reject);
        else entry.reject(new WorkerCallError(msg.payload.error || 'Worker error', msg.payload.code));
      }
    });
    worker.addEventListener('error', (event: ErrorEvent) => {
      const err = new WorkerCallError(event.message || 'Worker crashed');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
      this.jobDone();
    });
    return worker;
  }

  private jobDone() {
    if (this.pending.size) return;
    this.endJob?.();
    this.endJob = null;
  }

  call<T>(action: string, payload: unknown, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<T> {
    const id = crypto.randomUUID();
    const worker = this.worker ?? this.start();
    // Memory fail-safe: stop the worker (freeing its memory) if the app goes over budget.
    this.endJob ??= registerJob((err) => this.stop(err));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      try {
        worker.postMessage({ id, action, payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        this.jobDone();
        reject(err);
      }
    });
  }

  /** Ends the worker, failing whatever is in flight with `err`; the next call starts a fresh one. */
  private stop(err: Error) {
    this.worker?.terminate();
    this.worker = null;
    this.outputs?.dispose();
    this.outputs = null;
    this.detachMemory?.();
    this.detachMemory = null;
    this.endJob = null;
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }

  terminate(): void {
    this.endJob?.();
    this.stop(new WorkerCallError('Worker terminated'));
  }
}
