/**
 * Worker side of the memory fail-safe: the page tells each worker its RAM
 * budget and the current memory level (memoryGuard.ts), and tools size
 * their caches and decide how much to hold at once from it.
 *
 * Tools call `memoryCheckpoint()` between pieces of work (an image, a page,
 * a chunk of output): while memory is over the budget it drops what tools
 * registered with `onMemoryPressure` and waits until memory is back under,
 * so the job slows down instead of being stopped.
 */

type Level = 'normal' | 'high' | 'over' | 'critical';

let budget = 2 * 1024 * 1024 * 1024;
let level: Level = 'normal';
const waiters = new Set<() => void>();
const relievers = new Set<() => void>();

if (typeof self !== 'undefined' && typeof (self as { addEventListener?: unknown }).addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent) => {
    const m = event.data;
    if (m?.type !== 'MEM_CONFIG') return;
    if (m.budgetBytes > 0) budget = m.budgetBytes;
    if (m.level) level = m.level;
    if (level !== 'over') {
      waiters.forEach((w) => w());
      waiters.clear();
    }
  });
}

/** The RAM a job may use on this PC, in bytes. */
export const memoryBudget = () => budget;

/** True when memory is getting tight: prefer slower, leaner ways of working. */
export const memoryTight = () => level !== 'normal';

/** Registers a way to free memory (drop a cache) when memory runs over the budget. */
export function onMemoryPressure(relieve: () => void): () => void {
  relievers.add(relieve);
  return () => relievers.delete(relieve);
}

/** Longest a job waits at one checkpoint; the watchdog decides if it's stuck over the budget. */
const MAX_WAIT_MS = 30_000;

/**
 * Between pieces of work: returns at once normally; while memory is over the
 * budget, frees what it can and waits until it's back under.
 */
export function memoryCheckpoint(): Promise<void> | void {
  if (level !== 'over') return;
  relievers.forEach((r) => {
    try {
      r();
    } catch {
      /* a cache that can't be dropped just stays */
    }
  });
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      waiters.delete(done);
      resolve();
    };
    const timer = setTimeout(done, MAX_WAIT_MS);
    waiters.add(done);
  });
}
