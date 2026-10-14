/**
 * Page side of the local usage log (electron/usageLog.cjs). Tells the desktop
 * app which tool is open and when a job starts and ends. Only sizes, counts and
 * outcomes go across: never a file name or any of a document's content. In a
 * browser tab there is no log, and every call does nothing.
 */

export type JobOutcome = 'ok' | 'error' | 'stopped' | 'cancelled';

const bridge = () => (typeof window !== 'undefined' ? window.ihpDesktop?.log : undefined);

/** The tool id from the address (#/compress → "compress"), "home" when none. */
export const currentTool = (): string => window.location.hash.replace(/^#\/?/, '').split(/[?/]/)[0] || 'home';

export function logToolOpen(tool: string): void {
  bridge()?.tool(tool);
}

/** Bytes and count of whatever a job is given (buffers, blobs, files; nested, shallow). */
export function inputSize(payload: unknown): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const seen = new Set<unknown>();
  const visit = (v: unknown, depth: number) => {
    if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return;
    seen.add(v);
    if (v instanceof ArrayBuffer) {
      bytes += v.byteLength;
      files++;
    } else if (ArrayBuffer.isView(v)) {
      bytes += v.byteLength;
      files++;
    } else if (typeof Blob !== 'undefined' && v instanceof Blob) {
      bytes += v.size;
      files++;
    } else if (Array.isArray(v)) {
      for (const x of v.slice(0, 2000)) visit(x, depth + 1);
    } else {
      for (const x of Object.values(v as Record<string, unknown>)) visit(x, depth + 1);
    }
  };
  visit(payload, 0);
  return { bytes, files };
}

/** Size of a finished job's result (in memory, or stored in a temp file or Blob). */
export function outputSize(result: unknown): number {
  const r = result as { buffer?: ArrayBuffer; output?: { size?: number }; size?: number } | null;
  return r?.buffer?.byteLength ?? r?.output?.size ?? r?.size ?? 0;
}

/**
 * Starts logging one job; call `end` once, with how it went. Errors are
 * classified in the desktop app, which strips anything that looks like a file name.
 */
export function logJob(info: { tool?: string; inputBytes: number; inputFiles: number }) {
  const log = bridge();
  if (!log) return { end: (_outcome: JobOutcome, _extra?: { outputBytes?: number; error?: unknown }) => undefined };
  const id = crypto.randomUUID();
  log.jobStart(id, { tool: info.tool || currentTool(), inputBytes: info.inputBytes, inputFiles: info.inputFiles });
  let ended = false;
  return {
    end(outcome: JobOutcome, extra: { outputBytes?: number; error?: unknown } = {}) {
      if (ended) return;
      ended = true;
      const e = extra.error;
      log.jobEnd(id, { outcome, outputBytes: extra.outputBytes, error: e instanceof Error ? e.message : e ? String(e) : undefined });
    },
  };
}

/** How a rejected job is recorded: stopped by the memory fail-safe, cancelled, or an error. */
export function outcomeOf(err: unknown): JobOutcome {
  const name = (err as { name?: string } | null)?.name;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  if (name === 'MemoryLimitError' || /stopped to protect this pc/i.test(msg)) return 'stopped';
  if (/cancelled/i.test(msg)) return 'cancelled';
  return 'error';
}
