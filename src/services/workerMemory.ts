/**
 * Worker side of the memory fail-safe: the page tells each worker its RAM
 * budget and the current memory level (memoryGuard.ts), and tools size
 * their caches and decide how much to hold at once from it.
 */

let budget = 2 * 1024 * 1024 * 1024;
let level: 'normal' | 'high' | 'critical' = 'normal';

if (typeof self !== 'undefined' && typeof (self as { addEventListener?: unknown }).addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent) => {
    const m = event.data;
    if (m?.type !== 'MEM_CONFIG') return;
    if (m.budgetBytes > 0) budget = m.budgetBytes;
    if (m.level) level = m.level;
  });
}

/** The app's RAM budget on this PC, in bytes. */
export const memoryBudget = () => budget;

/** True when memory is getting tight: prefer slower, leaner ways of working. */
export const memoryTight = () => level !== 'normal';
