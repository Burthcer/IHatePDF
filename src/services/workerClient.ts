/**
 * Promise-based client for a long-lived worker that can have several
 * requests in flight (unlike useWorkerBridge, which runs one task at a time
 * and restarts the worker to cancel). Used by stateful workers such as the
 * editor's session worker.
 */

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
  private worker: Worker;
  private pending = new Map<string, Pending>();

  constructor(factory: () => Worker) {
    this.worker = factory();
    this.worker.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || !msg.payload) return;
      const entry = this.pending.get(msg.payload.id);
      if (!entry) return;
      if (msg.type === 'PROGRESS') {
        entry.onProgress?.(msg.payload.progress, msg.payload.stage);
      } else if (msg.type === 'RESPONSE') {
        this.pending.delete(msg.payload.id);
        if (msg.payload.success) entry.resolve(msg.payload.data);
        else entry.reject(new WorkerCallError(msg.payload.error || 'Worker error', msg.payload.code));
      }
    });
    this.worker.addEventListener('error', (event: ErrorEvent) => {
      const err = new WorkerCallError(event.message || 'Worker crashed');
      this.pending.forEach((p) => p.reject(err));
      this.pending.clear();
    });
  }

  call<T>(action: string, payload: unknown, transfer: Transferable[] = [], onProgress?: Pending['onProgress']): Promise<T> {
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onProgress });
      try {
        this.worker.postMessage({ id, action, payload }, transfer);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  terminate(): void {
    this.worker.terminate();
    const err = new WorkerCallError('Worker terminated');
    this.pending.forEach((p) => p.reject(err));
    this.pending.clear();
  }
}
