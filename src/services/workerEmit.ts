/**
 * How PDF tools hand back their result: streamed to the page when running in
 * the app (sink given), or as one buffer (tests and small in-memory outputs).
 */

import type { PDFDocument, PDFRef } from 'pdf-lib';
import { saveSequential, saveToBuffer, saveToSink, type DeferredStream, type StreamSaveOptions } from './pdfStreamSave';
import { copyInputToOutput, type OutputSink } from './workerOutput';
import type { PdfInput, ToolOutput } from '../types/worker';

export interface Emitted {
  buffer?: ArrayBuffer;
  output?: ToolOutput;
  size: number;
}

export async function emitPdf(doc: PDFDocument, sink: OutputSink | undefined, options: StreamSaveOptions = {}): Promise<Emitted> {
  if (sink) {
    await saveToSink(doc, sink, options);
    const output = await sink.close();
    return { output, size: output.size };
  }
  const bytes = await saveToBuffer(doc, options);
  return { buffer: bytes.buffer as ArrayBuffer, size: bytes.byteLength };
}

export async function emitBytes(bytes: Uint8Array, sink: OutputSink | undefined): Promise<Emitted> {
  if (sink) {
    const STEP = 4 * 1024 * 1024;
    for (let pos = 0; pos < bytes.length; pos += STEP) await sink.write(bytes.slice(pos, pos + STEP));
    const output = await sink.close();
    return { output, size: output.size };
  }
  const buffer = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? (bytes.buffer as ArrayBuffer) : (bytes.slice().buffer as ArrayBuffer);
  return { buffer, size: bytes.byteLength };
}

/** Streams `doc` front to back, producing `deferred` objects as they're reached (see saveSequential). */
export async function emitSequential(doc: PDFDocument, sink: OutputSink | undefined, deferred: Map<PDFRef, DeferredStream>): Promise<Emitted> {
  if (sink) {
    await saveSequential(doc, sink, deferred);
    const output = await sink.close();
    return { output, size: output.size };
  }
  const parts: Uint8Array[] = [];
  const size = await saveSequential(doc, { write: (c) => void parts.push(c.slice()) }, deferred);
  const bytes = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    bytes.set(p, o);
    o += p.length;
  }
  return { buffer: bytes.buffer as ArrayBuffer, size };
}

/** Hands back the input file unchanged (e.g. "nothing could be made smaller"). */
export async function emitInput(input: PdfInput, sink: OutputSink | undefined): Promise<Emitted> {
  if (sink) {
    const output = await copyInputToOutput(input, sink);
    return { output, size: output.size };
  }
  const buffer = input instanceof Blob ? await input.arrayBuffer() : input.slice(0);
  return { buffer, size: buffer.byteLength };
}

export const inputSize = (input: PdfInput) => (input instanceof Blob ? input.size : input.byteLength);

/** Transfer list for a result posted back to the page. */
export const transferOf = (r: { buffer?: ArrayBuffer }): Transferable[] => (r.buffer ? [r.buffer] : []);
