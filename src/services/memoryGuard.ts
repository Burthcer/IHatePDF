/**
 * Page side of the memory fail-safe (electron/memoryGuard.cjs). The desktop
 * app reports how much of its RAM budget is in use:
 *  - high: workers are told to trade speed for memory (smaller caches, one
 *    thing at a time);
 *  - critical: every running job is stopped at once — terminating its worker
 *    frees its memory immediately — and the user is told why.
 * In a browser there's no watchdog; the budget is estimated from the
 * device's memory and only used to size things.
 */

export type MemoryLevel = 'normal' | 'high' | 'critical';

export interface MemoryState {
  level: MemoryLevel;
  usedMB: number;
  budgetMB: number;
  totalMB: number;
  availableMB: number;
}

export class MemoryLimitError extends Error {
  constructor(state: MemoryState) {
    const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;
    super(
      `Stopped to protect this PC: the job needed more memory than IHatePDF is allowed to use here (${gb(state.budgetMB)} of ${gb(state.totalMB)} RAM). ` +
        'Nothing was changed. Close other programs and try again, or split the file into smaller parts first.'
    );
    this.name = 'MemoryLimitError';
  }
}

function estimate(): MemoryState {
  // deviceMemory is rounded and capped at 8 (GB); assume 4 GB when unknown.
  const totalMB = ((navigator as { deviceMemory?: number }).deviceMemory ?? 4) * 1024;
  const budgetMB = Math.max(1024, Math.min(totalMB * 0.5, totalMB - 3072, 16384));
  return { level: 'normal', usedMB: 0, budgetMB, totalMB, availableMB: totalMB };
}

let state: MemoryState = typeof navigator !== 'undefined' ? estimate() : { level: 'normal', usedMB: 0, budgetMB: 2048, totalMB: 4096, availableMB: 4096 };
const listeners = new Set<(s: MemoryState) => void>();
const jobs = new Set<(err: MemoryLimitError) => void>();
const workers = new Set<Worker>();
let lastStopped: MemoryLimitError | null = null;

function configMessage() {
  return { type: 'MEM_CONFIG', budgetBytes: state.budgetMB * 1024 * 1024, level: state.level };
}

function update(next: MemoryState) {
  const changed = next.level !== state.level || next.budgetMB !== state.budgetMB;
  state = next;
  if (changed) workers.forEach((w) => w.postMessage(configMessage()));
  if (next.level === 'critical' && jobs.size) {
    const err = new MemoryLimitError(next);
    lastStopped = err;
    const cancels = [...jobs];
    jobs.clear();
    cancels.forEach((cancel) => {
      try {
        cancel(err);
      } catch (e) {
        console.error('Stopping a job failed', e);
      }
    });
  }
  listeners.forEach((l) => l(state));
}

if (typeof window !== 'undefined' && window.ihpDesktop?.memory) {
  void window.ihpDesktop.memory.info().then(update, () => undefined);
  window.ihpDesktop.memory.onChange(update);
}

export const memoryState = () => state;

export function subscribeMemory(listener: (s: MemoryState) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The error of the last job stopped by the fail-safe (for a notice), then forgets it. */
export function takeStoppedJob(): MemoryLimitError | null {
  const e = lastStopped;
  lastStopped = null;
  return e;
}

/**
 * Registers something that can be stopped to free memory (a worker task, a
 * render loop). Returns a function to call when it's finished.
 */
export function registerJob(cancel: (err: MemoryLimitError) => void): () => void {
  jobs.add(cancel);
  return () => jobs.delete(cancel);
}

/** For loops on the page: `check()` throws once the fail-safe has stopped jobs. */
export function startJob() {
  let stopped: MemoryLimitError | null = null;
  const end = registerJob((err) => (stopped = err));
  return {
    check() {
      if (stopped) throw stopped;
    },
    end,
  };
}

/** Keeps a worker told of the budget and memory level (see workerMemory.ts). */
export function attachWorker(worker: Worker): () => void {
  workers.add(worker);
  worker.postMessage(configMessage());
  return () => workers.delete(worker);
}

/** Largest canvas to render into, in pixels (a canvas costs 4 bytes a pixel, plus copies). */
export function maxCanvasPixels(): number {
  const byBudget = (state.budgetMB * 1024 * 1024) / 40;
  return Math.max(8_000_000, Math.min(40_000_000, state.level === 'normal' ? byBudget : byBudget / 2));
}
