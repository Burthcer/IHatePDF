/**
 * Worker side of streamed tool output: chunks go to the page (which writes
 * them to a temp file in the desktop app, or a Blob in a browser) with at
 * most a few in flight, so the output file never has to fit in memory.
 */

import type { ChunkSink } from './pdfStreamSave';
import type { ToolOutput } from '../types/worker';

const MAX_IN_FLIGHT = 2;
/** Writes smaller than this are gathered into one chunk of about this size. */
const BATCH_BYTES = 4 * 1024 * 1024;
const acks = new Map<string, () => void>();

if (typeof self !== 'undefined' && typeof (self as { addEventListener?: unknown }).addEventListener === 'function') {
  self.addEventListener('message', (event: MessageEvent) => {
    const m = event.data;
    if (m && m.type === 'OUTPUT_ACK') acks.get(m.id)?.();
  });
}

export interface OutputSink extends ChunkSink {
  /** Waits for every chunk to be stored and returns the output handle. */
  close(): Promise<ToolOutput>;
  /** Stops writing; whatever was stored is discarded by the page. */
  abort(): void;
}

/** Opens a streamed output for request `id`. */
export function openOutput(id: string): OutputSink {
  let inFlight = 0;
  let size = 0;
  let waiting: (() => void) | null = null;
  acks.set(id, () => {
    inFlight--;
    const w = waiting;
    waiting = null;
    w?.();
  });
  const post = (payload: Record<string, unknown>, transfer: Transferable[] = []) =>
    (self as unknown as Worker).postMessage({ type: 'OUTPUT', payload: { id, ...payload } }, transfer);
  post({ op: 'open' });
  const drain = async (limit: number) => {
    while (inFlight > limit) await new Promise<void>((r) => (waiting = r));
  };
  const send = async (own: Uint8Array) => {
    await drain(MAX_IN_FLIGHT - 1);
    size += own.byteLength;
    inFlight++;
    post({ op: 'chunk', chunk: own }, [own.buffer]);
  };
  // Small writes (a ZIP's headers, thousands of tiny files) are batched: every
  // chunk is a round trip to the page and, in the app, to the disk writer.
  let batch: Uint8Array[] = [];
  let batchBytes = 0;
  const flush = async () => {
    if (!batchBytes) return;
    const out = new Uint8Array(batchBytes);
    let o = 0;
    for (const b of batch) {
      out.set(b, o);
      o += b.byteLength;
    }
    batch = [];
    batchBytes = 0;
    await send(out);
  };
  return {
    async write(chunk: Uint8Array) {
      if (chunk.byteLength >= BATCH_BYTES) {
        await flush();
        await send(chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk : chunk.slice());
        return;
      }
      batch.push(chunk.slice());
      batchBytes += chunk.byteLength;
      if (batchBytes >= BATCH_BYTES) await flush();
    },
    async close() {
      await flush();
      await drain(0);
      acks.delete(id);
      post({ op: 'close' });
      return { kind: 'stream', id, size };
    },
    abort() {
      acks.delete(id);
      post({ op: 'abort' });
    },
  };
}

/** Copies the whole input straight to an output (e.g. "nothing could be made smaller"). */
export async function copyInputToOutput(input: Blob | ArrayBuffer, sink: OutputSink): Promise<ToolOutput> {
  const STEP = 4 * 1024 * 1024;
  if (input instanceof Blob) {
    for (let pos = 0; pos < input.size; pos += STEP) await sink.write(new Uint8Array(await input.slice(pos, pos + STEP).arrayBuffer()));
  } else {
    for (let pos = 0; pos < input.byteLength; pos += STEP) await sink.write(new Uint8Array(input.slice(pos, pos + STEP)));
  }
  return sink.close();
}
