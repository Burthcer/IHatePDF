/**
 * One-off messages for the whole app (shown by SystemNotice), for problems a tool
 * can't show itself, e.g. a page preview that can't open. The same text is shown once.
 */

type Listener = (message: string | null) => void;

const listeners = new Set<Listener>();
let current: string | null = null;

export function showNotice(message: string): void {
  if (message === current) return;
  current = message;
  listeners.forEach((l) => l(current));
}

export function clearNotice(): void {
  if (current === null) return;
  current = null;
  listeners.forEach((l) => l(null));
}

export function subscribeNotice(l: Listener): () => void {
  listeners.add(l);
  l(current);
  return () => listeners.delete(l);
}
