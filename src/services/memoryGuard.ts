/**
 * Page side of the memory fail-safe (electron/memoryGuard.cjs). The desktop
 * app reports how much memory the running jobs have taken, against the RAM
 * budget for this PC (the app's own idle memory doesn't count):
 *  - high: workers work in smaller pieces (smaller caches, one thing at a
 *    time), and the app says "Low on memory: taking longer";
 *  - over: jobs pause at their next piece and carry on once memory is back
 *    under the budget;
 *  - critical (last resort: Windows nearly out of memory, or one piece of
 *    the job doesn't fit): every running job is stopped at once —
 *    terminating its worker frees its memory immediately — and the user is
 *    told why.
 * In a browser there's no watchdog; the budget is estimated from the
 * device's memory and only used to size things.
 */

export type MemoryLevel = 'normal' | 'high' | 'over' | 'critical';

export interface MemoryState {
  level: MemoryLevel;
  /** Why a job had to be stopped: Windows is nearly out of memory, or one piece of it doesn't fit. */
  reason?: 'system' | 'too-big';
  usedMB: number;
  /** Memory the running jobs have taken (the app's own idle memory not included). */
  jobMB?: number;
  budgetMB: number;
  /** What a job may use right now: the budget, or less while Windows itself is short of memory. */
  limitMB?: number;
  totalMB: number;
  availableMB: number;
}

const gb = (mb: number) => `${(mb / 1024).toFixed(1)} GB`;

export class MemoryLimitError extends Error {
  constructor(state: MemoryState) {
    super(
      state.reason === 'system'
        ? `Stopped to protect this PC: Windows is almost out of memory (${gb(state.availableMB)} free of ${gb(state.totalMB)}). Nothing was changed. Close other programs and try again.`
        : `Stopped to protect this PC: part of this job needs more memory than IHatePDF may use here (${gb(state.budgetMB)} of ${gb(state.totalMB)} RAM), even working in small pieces. ` +
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

const desktop = () => (typeof window !== 'undefined' ? window.ihpDesktop?.memory : undefined);

let state: MemoryState = typeof navigator !== 'undefined' ? estimate() : { level: 'normal', usedMB: 0, budgetMB: 2048, totalMB: 4096, availableMB: 4096 };
const listeners = new Set<(s: MemoryState) => void>();
const jobs = new Set<(err: MemoryLimitError) => void>();
const workers = new Set<Worker>();
let lastStopped: MemoryLimitError | null = null;

function configMessage() {
  return { type: 'MEM_CONFIG', budgetBytes: currentLimitMB() * 1024 * 1024, level: state.level };
}

const notify = () => listeners.forEach((l) => l(state));

let lastCollect = 0;
/**
 * Frees memory nothing uses any more, now rather than when the engine gets
 * round to it (the desktop app exposes gc() for this), at most once a second.
 */
export function collectGarbage(): void {
  const gc = (globalThis as { gc?: () => void }).gc;
  if (!gc || Date.now() - lastCollect < 1000) return;
  lastCollect = Date.now();
  try {
    gc();
  } catch {
    /* not available */
  }
}

function jobsChanged() {
  desktop()?.jobs?.(jobs.size);
  notify();
}

function update(next: MemoryState) {
  const changed = next.level !== state.level || next.budgetMB !== state.budgetMB || next.limitMB !== state.limitMB;
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
    desktop()?.jobs?.(0);
  }
  // Near or over the budget, garbage (e.g. result chunks already written to disk) goes first.
  if (next.level !== 'normal') collectGarbage();
  notify();
  // Answering shows the watchdog this page isn't stuck: it has paused or stopped its jobs.
  if (next.level === 'over' || next.level === 'critical') desktop()?.ack?.();
}

if (desktop()) {
  void desktop()!.info().then(update, () => undefined);
  desktop()!.onChange(update);
}

export const memoryState = () => state;

/** What a job may use right now, in MB (the budget, or less while Windows is short of memory). */
export const currentLimitMB = () => Math.min(state.budgetMB, state.limitMB ?? state.budgetMB);

/** True while the limit is lower than the budget because Windows itself is short of memory. */
export const windowsShort = () => currentLimitMB() < state.budgetMB;

/** True while a job is running (for "Low on memory: taking longer"). */
export const jobsRunning = () => jobs.size > 0;

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
  jobsChanged();
  return () => {
    if (jobs.delete(cancel)) jobsChanged();
  };
}

/** Resolves once memory is no longer over the budget (or after `maxMs`, when the watchdog decides). */
export function whileOver(maxMs = 30_000): Promise<void> {
  if (state.level !== 'over') return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, maxMs);
    const sweep = setInterval(collectGarbage, 1000);
    collectGarbage();
    const unsubscribe = subscribeMemory((s) => s.level !== 'over' && done());
    function done() {
      clearTimeout(timer);
      clearInterval(sweep);
      unsubscribe();
      resolve();
    }
  });
}

/**
 * For loops on the page. `check()` throws once the fail-safe has stopped jobs;
 * `checkpoint()`, between pieces of work, also waits while memory is over the
 * budget, so the job pauses and carries on instead of being stopped.
 */
export function startJob() {
  let stopped: MemoryLimitError | null = null;
  const end = registerJob((err) => (stopped = err));
  const check = () => {
    if (stopped) throw stopped;
  };
  return {
    check,
    async checkpoint() {
      check();
      await whileOver();
      check();
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
  const byBudget = (currentLimitMB() * 1024 * 1024) / 40;
  return Math.max(4_000_000, Math.min(40_000_000, state.level === 'normal' ? byBudget : byBudget / 2));
}
